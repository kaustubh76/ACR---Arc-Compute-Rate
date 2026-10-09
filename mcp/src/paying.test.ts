/** The paying half, and the 401 that made every tool fail at once.
 *
 * These tests exist because 16 green tests coexisted with a published config in
 * which four of five tools answered `401 "agent card signature does not match
 * its agent"`. The reason they could is in the first group below: the suite fakes
 * `fetch`, so a card signed for the wrong chain was never presented to anything
 * that would check it. The fix was to stop defaulting the chain id; the tests
 * here pin that it comes from the gate, and that an unresolvable one produces an
 * ANONYMOUS call rather than a card the gate will refuse.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CARD_HEADER, gateChainId, withCard } from "./card.js";
import { arcChain, knownChainIds, USDC_DECIMALS } from "./chain.js";
import { admits, fundingStep, newLedger, priceFromChallenge, record, validateKey } from "./pay.js";
import { canIPay } from "./preflight.js";
import { callTool, TOOLS, toolsFor, UNIT_SANITY_BP, UNITS } from "./tools.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* NO TEST MAY TOUCH THE DEVELOPER'S OWN LEDGER.
 *
 * `check_spend` now records each priced bill, and `spendLog.logPath` defaults
 * to `~/.acr/spend.jsonl` — so the first run of this suite after that change
 * wrote three fake bills into my real home directory. A unit suite that
 * pollutes the machine it runs on is a unit suite nobody can trust twice.
 *
 * Set here rather than passed per call, so a test added later cannot forget:
 * `callTool` falls back to `process.env` when no `env` is given, and this IS
 * that fallback. `spendLog.test.ts` asserts the default path separately,
 * without writing to it. */
process.env.ACR_SPEND_LOG = join(mkdtempSync(join(tmpdir(), "acr-mcp-test-")), "spend.jsonl");


const KEY = `0x${"11".repeat(32)}` as const;

/** A router keyed on the path, so one fake can serve a whole ladder. Records
 *  every call with its headers. */
function router(
  table: Record<string, { status?: number; body?: unknown }>,
  seen: Array<{ url: string; headers?: Record<string, string> }> = [],
) {
  return async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    seen.push({ url, headers: init?.headers });
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const hit = table[path];
    const status = hit?.status ?? (hit ? 200 : 404);
    return { ok: status >= 200 && status < 300, status, json: async () => hit?.body ?? {} };
  };
}

/** A gate that behaves like the real one: /agent/challenge answers 200 with its
 *  own chain_id even to an uncarded caller, which is what makes it usable as the
 *  source of truth for the card. */
const GATE_CHALLENGE = { chain_id: 5042, error: "agent card required", header: CARD_HEADER };

// ───────────────────────────────────────────────────── the card's chain id

test("the card's chain id comes from the gate, not from a default", async () => {
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  const raw = router({ "/agent/challenge": { body: GATE_CHALLENGE }, "/agent/whoami": { body: { tier: "carded" } } }, seen);
  const resolve = gateChainId(raw, "https://acr.test");
  assert.equal(await resolve(), 5042, "the gate said 5042, so that is what a card must be signed for");
  // Cached: a second ask must not re-probe. A free-tier press is slow enough
  // that one probe per tool call would be felt.
  await resolve();
  assert.equal(seen.filter((c) => c.url.includes("/agent/challenge")).length, 1);
});

test("ACR_ARC_CHAIN_ID overrides the gate, and never probes it", async () => {
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  const resolve = gateChainId(router({ "/agent/challenge": { body: GATE_CHALLENGE } }, seen), "https://acr.test", "31337");
  assert.equal(await resolve(), 31337);
  assert.equal(seen.length, 0, "an explicit id must not need the network at all");
});

test("an unreachable gate yields no chain id, and is not cached as a failure", async () => {
  let calls = 0;
  const flaky = async (_url: string) => {
    calls += 1;
    if (calls === 1) throw new Error("ECONNRESET");
    return { ok: true, status: 200, json: async () => GATE_CHALLENGE };
  };
  const resolve = gateChainId(flaky as never, "https://acr.test");
  assert.equal(await resolve(), null, "unknown beats guessed");
  assert.equal(await resolve(), 5042, "a cold start must not demote the whole session");
});

test("REGRESSION: with no resolvable chain id, the call goes out ANONYMOUS, not mis-signed", async () => {
  // The shipped failure: a card signed for 5042002 presented to a gate on 5042.
  // The chain id is inside the EIP-712 domain, so the gate recovers a different
  // address and 401s EVERY tool. An anonymous call is a documented working state
  // on a lower rate-limit bucket, so it is strictly the better failure.
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  const f = withCard(router({ "/rating/0xabc": { body: { available: true, n: 3 } } }, seen), {
    privateKey: KEY,
    chainId: async () => null,
  });
  await f("https://acr.test/rating/0xabc");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers?.[CARD_HEADER], undefined, "no card beats a card the gate will refuse");
});

test("with a resolvable chain id the card IS presented", async () => {
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  const f = withCard(router({ "/rating/0xabc": { body: {} } }, seen), {
    privateKey: KEY,
    chainId: async () => 5042,
  });
  await f("https://acr.test/rating/0xabc");
  assert.ok((seen[0].headers?.[CARD_HEADER] ?? "").length > 200, "a real card is a base64 blob");
});

// ───────────────────────────────────────────────────── the chain table

test("every known chain carries what a payment check needs", () => {
  for (const id of knownChainIds()) {
    const c = arcChain(id);
    assert.ok(c, `chain ${id} must resolve`);
    assert.equal(c.chainId, id);
    assert.equal(c.caip2, `eip155:${id}`);
    assert.match(c.publicRpc, /^https:\/\//, "a reader needs an RPC");
    assert.match(c.gatewayWallet, /^0x[0-9a-fA-F]{40}$/, "a settlement spends the Gateway balance");
  }
  assert.equal(USDC_DECIMALS, 6, "the ERC-20 view, never the 18-decimal native one");
});

test("an unknown chain is reported, never guessed", () => {
  assert.equal(arcChain(1), null, "Ethereum mainnet is not an Arc, and must not resolve to one");
});

test("ACR_ARC_RPC_URL overrides the public RPC without touching anything else", () => {
  const c = arcChain(5042, { ACR_ARC_RPC_URL: "https://keyed.example/rpc" } as NodeJS.ProcessEnv);
  assert.equal(c?.publicRpc, "https://keyed.example/rpc");
  assert.equal(c?.gatewayWallet, arcChain(5042)?.gatewayWallet);
});

// ───────────────────────────────────────────────────── funding and the cap

test("fundingStep names which of the two balances is short", () => {
  // An x402 settlement spends the GATEWAY balance. A wallet full of USDC with an
  // empty Gateway balance cannot pay — it has to deposit — and saying "ready"
  // there would send a developer looking for a bug that is not there.
  assert.equal(fundingStep(100, 100, 0.0001), "ready");
  assert.equal(fundingStep(100, 0, 0.0001), "deposit", "USDC in the wallet is not in the Gateway");
  assert.equal(fundingStep(0, 0, 0.0001), "bridge");
  assert.equal(fundingStep(0, 0.0001, 0.0001), "ready", "exactly the price is enough");
});

test("the spend cap is per process, counts what it spent, and refuses past it", () => {
  const l = newLedger("0.0003");
  assert.equal(l.maxUsdc, 0.0003);
  assert.equal(admits(l, 0.0001).ok, true);
  record(l, 0.0001);
  record(l, 0.0001);
  assert.equal(l.calls, 2);
  const third = admits(l, 0.0001);
  assert.equal(third.ok, true, "the third call is exactly at the cap");
  record(l, 0.0001);
  const fourth = admits(l, 0.0001);
  assert.equal(fourth.ok, false);
  assert.match((fourth as { reason: string }).reason, /ACR_MAX_SPEND_USDC/, "name the knob to turn");
});

test("a cap of zero is honoured, and a missing one defaults to a cent", () => {
  assert.equal(newLedger("0").maxUsdc, 0);
  assert.equal(admits(newLedger("0"), 0.0001).ok, false);
  assert.equal(newLedger(undefined).maxUsdc, 0.01);
  assert.equal(newLedger("not a number").maxUsdc, 0.01);
});

test("a key is validated by shape, and the reason names the length it got", () => {
  assert.deepEqual(validateKey(KEY), { key: KEY });
  assert.deepEqual(validateKey(` ${KEY} `), { key: KEY }, "a pasted key carries whitespace");
  const short = validateKey("0xdeadbeef");
  assert.match((short as { reason: string }).reason, /got 8 hex characters/, "locate the truncated paste");
});

test("the price is read from the challenge the gate actually sends", () => {
  // The live shape, copied from `GET /prints`: atomic units at 6 decimals.
  assert.equal(priceFromChallenge({ accepts: [{ amount: "100", maxAmountRequired: "100" }] }), 0.0001);
  assert.equal(priceFromChallenge({ accepts: [{ maxAmountRequired: "2500" }] }), 0.0025);
  assert.throws(() => priceFromChallenge({ accepts: [] }), /no readable price/);
});

// ───────────────────────────────────────────────────── can_i_pay

/** Every rung green except the ones that need a key of the developer's own. */
function payableGate(over: Record<string, { status?: number; body?: unknown }> = {}) {
  return {
    "/health": { body: { status: "ok", chain_id: 5042002, gate: "circle", signer: "circle" } },
    "/agent/whoami": { body: { tier: "carded", carded: true } },
    "/x402/info": {
      body: {
        facilitator: "circle",
        price_usdc: 0.0001,
        pay_to: "0x8366968f84a343CF70941EBe858428643d825cb0",
        gated_endpoints: ["/prints", "/prints/{index_id}", "/curve/{index_id}"],
      },
    },
    "/prints": {
      status: 402,
      body: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:5042002",
            asset: "0x3600000000000000000000000000000000000000",
            payTo: "0x8366968f84a343CF70941EBe858428643d825cb0",
            amount: "100",
            maxAmountRequired: "100",
          },
        ],
      },
    },
    ...over,
  };
}

test("can_i_pay with no payer key passes every rung it can and blocks on the key", async () => {
  const out = await canIPay({ api: "https://acr.test", fetchImpl: router(payableGate()) });
  assert.equal(out.can_pay, false);
  assert.equal(out.blocked_at, "payer", "the one thing a server cannot supply for you");
  assert.equal(out.price_usdc, 0.0001);
  assert.equal(out.chain_id, 5042002);
  const byName = Object.fromEntries(out.rungs.map((r) => [r.rung, r]));
  for (const rung of ["host", "chain", "card", "gate", "challenge"]) {
    assert.equal(byName[rung].ok, true, `${rung} should pass: ${byName[rung].detail}`);
  }
  assert.match(byName.payer.detail, /ACR_PAYER_PRIVATE_KEY/, "name the variable to set");
  assert.equal(byName.funds.not_reached, true, "no address means no balance, not a zero balance");
});

test("can_i_pay is the rung that catches a card the gate refuses", async () => {
  // The exact failure the published config had. Nothing else in the suite could
  // see it, because nothing else asked a gate what it made of the card.
  const out = await canIPay({
    api: "https://acr.test",
    fetchImpl: router(
      payableGate({
        "/agent/whoami": { status: 401, body: { detail: "agent card signature does not match its agent" } },
      }),
    ),
  });
  assert.equal(out.blocked_at, "card");
  assert.match(out.summary, /REFUSES this agent card/);
  assert.match(out.summary, /signature does not match/, "quote the gate rather than paraphrasing it");
});

test("can_i_pay says so when the endpoint is not behind the paywall at all", async () => {
  const out = await canIPay({
    api: "https://acr.test",
    endpoint: "/health",
    fetchImpl: router(payableGate()),
  });
  assert.equal(out.blocked_at, "gate");
  const gate = out.rungs.find((r) => r.rung === "gate");
  assert.match(gate!.detail, /answers free/);
  assert.match(gate!.detail, /\/prints/, "list the endpoints that ARE paid");
});

test("can_i_pay reports an unreachable press as sleeping, not as broken", async () => {
  const out = await canIPay({
    api: "https://acr.test",
    fetchImpl: (async () => {
      throw new Error("ETIMEDOUT");
    }) as never,
  });
  assert.equal(out.blocked_at, "host");
  assert.match(out.rungs[0].detail, /sleeps between visits/);
  assert.equal(out.rungs.find((r) => r.rung === "chain")?.not_reached, true);
});

test("can_i_pay reports a chain it has no profile for without pretending otherwise", async () => {
  const out = await canIPay({
    api: "https://acr.test",
    fetchImpl: router(payableGate({ "/health": { body: { chain_id: 999999 } } })),
  });
  assert.equal(out.blocked_at, "chain");
  assert.match(out.rungs[1].detail, /Payment may still work; this check cannot verify it/);
});

test("can_i_pay matches templated gated endpoints", async () => {
  const out = await canIPay({
    api: "https://acr.test",
    endpoint: "/curve/ACR-GPU",
    fetchImpl: router(payableGate({ "/curve/ACR-GPU": payableGate()["/prints"] })),
  });
  assert.equal(out.rungs.find((r) => r.rung === "gate")?.ok, true, "/curve/{index_id} must cover /curve/ACR-GPU");
});

// ───────────────────────────────────────────────────── pay_and_read

test("pay_and_read is not even offered without a payer key", () => {
  assert.ok(
    TOOLS.some((t) => t.name === "pay_and_read"),
    "the capability exists",
  );
  assert.equal(
    toolsFor(false).some((t) => t.name === "pay_and_read"),
    false,
    "a tool a host can see is a tool a model will try",
  );
  assert.ok(
    toolsFor(false).some((t) => t.name === "can_i_pay"),
    "can_i_pay must stay, so the model can explain what is missing",
  );
  assert.equal(toolsFor(true).length, TOOLS.length);
});

test("pay_and_read refuses with no key and names the variable", async () => {
  const out = (await callTool("pay_and_read", { endpoint: "/prints" }, {
    api: "https://acr.test",
    fetchImpl: router(payableGate()),
  })) as { paid: boolean; reason: string };
  assert.equal(out.paid, false);
  assert.match(out.reason, /ACR_PAYER_PRIVATE_KEY/);
});

test("pay_and_read prices the call BEFORE it authorizes anything", async () => {
  // The cap has to be checked against the real amount, not an assumed one, so the
  // 402 is read first. With the cap at zero nothing should ever reach the SDK.
  const seen: Array<{ url: string }> = [];
  const out = (await callTool("pay_and_read", { endpoint: "/prints" }, {
    api: "https://acr.test",
    fetchImpl: router(payableGate(), seen),
    payerKey: KEY,
    ledger: newLedger("0"),
  })) as { paid: boolean; reason: string; price_usdc: number };
  assert.equal(out.paid, false);
  assert.equal(out.price_usdc, 0.0001, "it learned the price from the gate");
  assert.match(out.reason, /over the \$0 cap/);
  assert.ok(
    seen.every((c) => !c.url.includes("PAYMENT")),
    "a refused call must not have attempted a settlement",
  );
});

test("pay_and_read refuses a chain it has no payment profile for", async () => {
  const out = (await callTool("pay_and_read", { endpoint: "/prints" }, {
    api: "https://acr.test",
    fetchImpl: router(payableGate({ "/health": { body: { chain_id: 999999 } } })),
    payerKey: KEY,
  })) as { paid: boolean; reason: string };
  assert.equal(out.paid, false);
  assert.match(out.reason, /no payment profile/);
});

test("pay_and_read says why when the endpoint never quotes a price", async () => {
  const out = (await callTool("pay_and_read", { endpoint: "/health" }, {
    api: "https://acr.test",
    fetchImpl: router(payableGate()),
    payerKey: KEY,
  })) as { paid: boolean; reason: string };
  assert.equal(out.paid, false);
  assert.match(out.reason, /did not answer with a priced 402/);
});

// ───────────────────────────────────────────────────── payment_receipts

test("payment_receipts narrows to this plugin's own payer", async () => {
  const mine = "0x19e7e376e7c213b7e7e7e7e7e7e7e7e7e7e7e7e7";
  const out = (await callTool("payment_receipts", {}, {
    api: "https://acr.test",
    payerKey: KEY,
    fetchImpl: router({
      "/marketplace/receipts": {
        body: { receipts: [{ payer: mine, amount_usdc: 0.0001 }, { payer: "0xsomeoneelse", amount_usdc: 5 }] },
      },
      "/revenue": { body: { paid_queries: 112, revenue_usdc: 0.333477, recent: [{ payer: mine }] } },
    }),
  })) as { payer: string; narrowed: boolean; receipts: unknown[]; caveat: string };
  assert.equal(out.narrowed, true);
  assert.equal(out.receipts.length, 0, "the stub payer is not the key's address, so nothing matches");
  assert.match(out.caveat, /floor, not a total/, "counts run short, never long");
});

test("payment_receipts without a payer returns the whole tape, and says it did", async () => {
  const out = (await callTool("payment_receipts", {}, {
    api: "https://acr.test",
    fetchImpl: router({
      "/marketplace/receipts": { body: { receipts: [{ payer: "0xa" }, { payer: "0xb" }] } },
      "/revenue": { body: { paid_queries: 2, revenue_usdc: 0.0002, recent: [] } },
    }),
  })) as { narrowed: boolean; receipts: unknown[]; revenue_counter: { paid_queries: number } };
  assert.equal(out.narrowed, false);
  assert.equal(out.receipts.length, 2);
  assert.equal(out.revenue_counter.paid_queries, 2);
});

// ───────────────────────────────────────────────────── benchmark_price

test("REGRESSION: benchmark_price refuses a comparison between different quantities", async () => {
  // It used to answer `available: true, slippage_bp: 2257157.1` for a $2.50
  // GPU-hour against an index level of 0.011 — a confident 22,572%. The index is
  // a level, not a dollar price per unit; the two are not the same quantity.
  const out = (await callTool("benchmark_price", { price: 2.5, index_id: "ACR-GPU" }, {
    api: "https://acr.test",
    fetchImpl: router({ "/onchain/ACR-GPU": { body: { value: 0.011027025952822034 } } }),
  })) as { available: boolean; reason: string };
  assert.equal(out.available, false);
  assert.match(out.reason, /not the same quantity/);
  assert.match(out.reason, /`unit`/, "point at the argument that fixes it");
});

test("benchmark_price still measures a quote that IS in the index's units", async () => {
  const out = (await callTool("benchmark_price", { price: 0.505, index_id: "ACR-INF" }, {
    api: "https://acr.test",
    fetchImpl: router({ "/onchain/ACR-INF": { body: { value: 0.5 } } }),
  })) as { available: boolean; slippage_bp: number; caveat: string };
  assert.equal(out.available, true);
  assert.equal(out.slippage_bp, 100, "+1% is +100 bp");
  assert.match(out.caveat, /index level/, "the weaker comparison must admit it is weaker");
});

test("the sanity bound is wide enough for a real bad deal and narrow enough for a unit error", () => {
  assert.ok(UNIT_SANITY_BP >= 10_000, "a 100% overcharge is a real answer, not a unit error");
  assert.ok(UNIT_SANITY_BP < 2_257_157, "the measured mismatch must fall outside it");
});

test("benchmark_price with a unit goes through /par, the real pre-trade verdict", async () => {
  const seen: Array<{ url: string }> = [];
  const out = (await callTool("benchmark_price", { price: 0.02, unit: "$/1k tokens", quantity: 10 }, {
    api: "https://acr.test",
    fetchImpl: router(
      { "/par": { body: { available: true, would: { intent: "pay", rule: "at or under par" } } } },
      seen,
    ),
  })) as { would: { intent: string } };
  assert.equal(out.would.intent, "pay");
  const call = seen[0].url;
  assert.match(call, /\/par\?/);
  assert.match(call, /unit=%24%2F1k%20tokens/, "the unit selects the market");
  assert.match(call, /billed_usdc=0\.2/, "price x quantity is the bill");
  assert.match(call, /quantity=10/);
});

test("benchmark_price falls back when the press predates /par, and asks for a unit when it cannot", async () => {
  const withIndex = (await callTool("benchmark_price", { price: 0.505, unit: "$/1k tokens", index_id: "ACR-INF" }, {
    api: "https://acr.test",
    fetchImpl: router({ "/onchain/ACR-INF": { body: { value: 0.5 } } }), // /par is 404 here
  })) as { available: boolean; slippage_bp: number };
  assert.equal(withIndex.available, true, "a 404 on /par must degrade, not fail");
  assert.equal(withIndex.slippage_bp, 100);

  const neither = (await callTool("benchmark_price", { price: 0.505 }, {
    api: "https://acr.test",
    fetchImpl: router({}),
  })) as { available: boolean; reason: string };
  assert.equal(neither.available, false);
  assert.match(neither.reason, /Pass `unit`/);
});

// ───────────────────────────────────────────────────── the two untested reads

test("seller_rating reads the rating route for the seller it was given", async () => {
  const seen: Array<{ url: string }> = [];
  await callTool("seller_rating", { seller: "0xabc", days: 90 }, {
    api: "https://acr.test",
    fetchImpl: router({ "/rating/0xabc": { body: { available: true, n: 22, grade: "D" } } }, seen),
  });
  assert.equal(seen[0].url, "https://acr.test/rating/0xabc?days=90");
});

test("get_rate reads the on-chain route, and reports an unposted oracle as a state", async () => {
  const seen: Array<{ url: string }> = [];
  const ok = (await callTool("get_rate", { index_id: "ACR-GPU" }, {
    api: "https://acr.test",
    fetchImpl: router({ "/onchain/ACR-GPU": { body: { value: 0.011, source: "onchain" } } }, seen),
  })) as { value: number };
  assert.equal(seen[0].url, "https://acr.test/onchain/ACR-GPU");
  assert.equal(ok.value, 0.011);

  // The measured state of the testnet press: the oracle has no posted prints, so
  // all three indices 404. That is a fact about the deployment, not a transport
  // failure, and `{error: "HTTP 404"}` reads as the latter.
  const none = (await callTool("get_rate", { index_id: "ACR-GPU" }, {
    api: "https://acr.test",
    fetchImpl: router({ "/onchain/ACR-GPU": { status: 404, body: { detail: "no on-chain print for ACR-GPU" } } }),
  })) as { available: boolean; reason: string; try_instead: string };
  assert.equal(none.available, false);
  assert.match(none.reason, /has not been posted to/);
  assert.match(none.try_instead, /pay_and_read/, "the value is still buyable from the metered endpoint");
});

test("a window that came back empty says it is a window, not a verdict", async () => {
  const empty = (await callTool("wallet_tca", { target: "0xabc" }, {
    api: "https://acr.test",
    fetchImpl: router({ "/tca/0xabc": { body: { available: true, purchases: 0 } } }),
  })) as { hint?: string };
  assert.match(empty.hint ?? "", /This is the window/);

  const full = (await callTool("wallet_tca", { target: "0xabc" }, {
    api: "https://acr.test",
    fetchImpl: router({ "/tca/0xabc": { body: { available: true, purchases: 87 } } }),
  })) as { hint?: string };
  assert.equal(full.hint, undefined, "a window with rows in it needs no hint");

  // A count that is ABSENT is not a count of zero — this distinction was wrong
  // first time round and put a "no rows" hint on answers that had rows.
  const noCount = (await callTool("wallet_tca", { target: "0xabc" }, {
    api: "https://acr.test",
    fetchImpl: router({ "/tca/0xabc": { body: { available: true, vw_slippage_bp: 41 } } }),
  })) as { hint?: string };
  assert.equal(noCount.hint, undefined);
});

test("query_tape distinguishes the press's screen failing closed from the caller's mistake", async () => {
  // Measured on the mainnet press 2026-10-09: its Model Armor credential was
  // never installed (`/armor/info` reports screened: 0, last_invocation: null),
  // so the screen fails closed and refuses every CARDED read of the tape. The
  // plugin must not let that read as "you did something wrong" — and must not
  // retry uncarded to get around it, which would be routing around a security
  // control to make a tool look like it works.
  const out = (await callTool("query_tape", { operation: "settlements" }, {
    api: "https://acr.test",
    fetchImpl: router({
      "/graph/query": {
        status: 502,
        body: {
          detail:
            "the agent screen could not reach a verdict on the request — refusing rather than " +
            "passing something uninspected",
        },
      },
    }),
  })) as { available: boolean; host_side: boolean; reason: string; check: string };
  assert.equal(out.available, false);
  assert.equal(out.host_side, true, "whose problem it is, stated");
  assert.match(out.reason, /not a problem with your call or your card/);
  assert.match(out.check, /armor\/info/, "name the descriptor that proves it");
});

test("query_tape passes a normal answer through untouched", async () => {
  const out = (await callTool("query_tape", { operation: "settlements" }, {
    api: "https://acr.test",
    fetchImpl: router({ "/graph/query": { body: { available: true, data: { settlements: [{ id: "0x1" }] } } } }),
  })) as { available: boolean; data: { settlements: unknown[] } };
  assert.equal(out.available, true);
  assert.equal(out.data.settlements.length, 1);
});

// ───────────────────────────────────────────────────── check_spend

test("the three units are the press's three, and no invented one survives", () => {
  // SHIPPED WRONG ONCE: the schema advertised "$/GPU-hour" and "$/GB-month",
  // neither of which exists, so two of the three units this plugin offered were
  // an instant 422. An example in a tool description is not documentation — it
  // is the value a model will actually send.
  assert.deepEqual([...UNITS], ["$/1k tokens", "$/GPU-sec", "$/MB"]);
  const schemas = JSON.stringify(TOOLS);
  for (const invented of ["$/GPU-hour", "$/GB-month", "$/GB", "$/token"]) {
    assert.ok(!schemas.includes(invented), `${invented} is not a unit the press accepts`);
  }
  // Every tool that takes a unit must offer the enum, so a model cannot guess.
  for (const t of TOOLS) {
    const u = (t.inputSchema.properties as Record<string, { enum?: string[] }>).unit;
    if (u) assert.deepEqual(u.enum, [...UNITS], `${t.name} must enumerate the units`);
  }
});

test("check_spend sends the bill AS BILLED, and the quantity beside it", async () => {
  // The whole point of the register's spec: an invoice says "$0.47 for 23 units".
  // Making the caller divide first is asking them to do the arithmetic the tool
  // exists to check — and it is what the older benchmark_price did.
  const seen: Array<{ url: string }> = [];
  await callTool("check_spend", { billed_usdc: 0.47, quantity: 23, unit: "$/1k tokens" }, {
    api: "https://acr.test",
    fetchImpl: router({ "/par": { body: { would: { intent: "pay", rule: "at par" } } } }, seen),
  });
  const u = new URL(seen[0].url);
  assert.equal(u.searchParams.get("billed_usdc"), "0.47", "the bill, not a per-unit price");
  assert.equal(u.searchParams.get("quantity"), "23");
  assert.equal(u.searchParams.get("unit"), "$/1k tokens");
  assert.equal(u.searchParams.has("vendor"), false, "no vendor means the param is ABSENT");
});

test("check_spend forwards a vendor, because it changes which market answers", async () => {
  // A seller ACR operates is judged against ACR's own fleet prices and anyone
  // else against the open market, and a vendor is excluded from its own
  // comparison set. Dropping the field silently changes the answer.
  const seen: Array<{ url: string }> = [];
  const vendor = "0xefe0E4625AFf072c3FCff230b47f8150A17aDF19";
  await callTool("check_spend", { billed_usdc: 1, quantity: 2, unit: "$/MB", vendor }, {
    api: "https://acr.test",
    fetchImpl: router({ "/par": { body: { would: { intent: "pay" } } } }, seen),
  });
  assert.equal(new URL(seen[0].url).searchParams.get("vendor"), vendor);
});

test("check_spend refuses a bad bill locally, and names WHICH field", async () => {
  const seen: Array<{ url: string }> = [];
  const opts = { api: "https://acr.test", fetchImpl: router({ "/par": { body: {} } }, seen) };
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ billed_usdc: 0, quantity: 1, unit: "$/MB" }, /billed_usdc/],
    [{ billed_usdc: -1, quantity: 1, unit: "$/MB" }, /billed_usdc/],
    [{ billed_usdc: 1, quantity: 0, unit: "$/MB" }, /quantity/],
    [{ billed_usdc: 1, quantity: 1, unit: "$/GPU-hour" }, /unit must be one of/],
    [{ billed_usdc: 1, quantity: 1, unit: "$/MB", vendor: "acme-corp" }, /vendor must be/],
  ];
  for (const [args, re] of cases) {
    const out = (await callTool("check_spend", args, opts)) as { available: boolean; reason: string };
    assert.equal(out.available, false, JSON.stringify(args));
    assert.match(out.reason, re);
  }
  assert.equal(seen.length, 0, "a bill refused locally must never reach the press");
});

test("an unknown unit hands back the three that work", async () => {
  const out = (await callTool("check_spend", { billed_usdc: 1, quantity: 1, unit: "$/widget" }, {
    api: "https://acr.test",
    fetchImpl: router({}),
  })) as { units: string[] };
  assert.deepEqual(out.units, [...UNITS], "a refusal that does not say what WOULD work is a dead end");
});

test("check_spend tells a press gap apart from a bad bill", async () => {
  // A 404 is a deployment that predates the benchmark; a 422 is the press
  // refusing this bill and naming the field. Two different things to do next,
  // so `host_side` says whose problem it is.
  const gap = (await callTool("check_spend", { billed_usdc: 1, quantity: 1, unit: "$/MB" }, {
    api: "https://acr.test",
    fetchImpl: router({ "/par": { status: 404, body: { detail: "Not Found" } } }),
  })) as { available: boolean; host_side: boolean; reason: string };
  assert.equal(gap.available, false);
  assert.equal(gap.host_side, true);
  assert.match(gap.reason, /predates the benchmark/);

  const badBill = (await callTool("check_spend", { billed_usdc: 1, quantity: 1, unit: "$/MB" }, {
    api: "https://acr.test",
    fetchImpl: router({
      "/par": { status: 422, body: { detail: "billed_usdc and quantity must both be positive" } },
    }),
  })) as { available: boolean; host_side: boolean; reason: string };
  assert.equal(badBill.host_side, false, "a 422 is about the bill, not about us");
  assert.match(badBill.reason, /could not read this bill/);
});

test("check_spend passes the press's verdict through untouched", async () => {
  // It must not reinterpret. The register's point is that this is the SAME
  // ladder the spend agent runs, so the verdict is the press's own words.
  const body = {
    would: { intent: "escalate", rule: "over the going market rate", recommended_intent: "refuse" },
    par: { par_usdc: 0.0004, best_usdc: 0.0001, sellers: 4 },
    over_rate_bp: 1781,
    vendor_supplied: false,
  };
  const out = (await callTool("check_spend", { billed_usdc: 0.02, quantity: 10, unit: "$/1k tokens" }, {
    api: "https://acr.test",
    fetchImpl: router({ "/par": { body } }),
  })) as typeof body & { recorded_to?: unknown };

  /* `recorded_to` is the ONE field this hop adds, and it is pulled off before
     the comparison rather than added to the expectation — so the assertion
     still says "everything else is the press's own words". If a future edit
     reinterprets a verdict or renames a field, this fails; if it adds a second
     local field, it also fails, which is the point. */
  const { recorded_to, ...passedThrough } = out;
  assert.deepEqual(passedThrough, body);
  assert.ok(
    typeof recorded_to === "string" || recorded_to === null,
    "check_spend must say where it recorded the bill, or that it did not",
  );
});

test("check_spend is read-only, so it is always offered", () => {
  // Unlike pay_and_read. A developer with no key and no history is exactly the
  // caller the register wrote this tool for.
  assert.ok(toolsFor(false).some((t) => t.name === "check_spend"));
  assert.ok(toolsFor(true).some((t) => t.name === "check_spend"));
});
