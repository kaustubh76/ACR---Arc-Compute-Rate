/** Every tool, against a real press. The check the unit suite cannot be.
 *
 *   npm run smoke                                     # the default host
 *   ACR_API=https://acr-api-mainnet.onrender.com npm run smoke
 *   ACR_AGENT_PRIVATE_KEY=0x… npm run smoke           # also exercise the card
 *   ACR_SMOKE_PAY=1 npm run smoke                     # … and SPEND, once
 *
 * WHY THIS EXISTS. `src/*.test.ts` fakes `fetch`, which is the right shape for a
 * CI job that uses no secrets and no network — and is exactly why a published
 * config in which four of five tools answered 401 passed every test. A fake gate
 * cannot refuse a card. So this probe talks to the live one, and its witness is
 * the gate's own verdict rather than anything this repo controls.
 *
 * Not in CI on purpose: it needs the network, and a free-tier press asleep is not
 * a failing build. Run it before publishing, and after any deploy that moves the
 * press — `npm run smoke` is the step that would have caught the 401.
 */

import { CARD_HEADER, gateChainId, mintCardHeader, withCard } from "../src/card.js";
import { arcChain } from "../src/chain.js";
import { callTool, DEFAULT_API, toolsFor, type Fetchish } from "../src/tools.js";

const api = (process.env.ACR_API ?? DEFAULT_API).replace(/\/$/, "");
const payerKey = (process.env.ACR_PAYER_PRIVATE_KEY ?? "").trim() || undefined;
const cardKey = (process.env.ACR_AGENT_PRIVATE_KEY ?? "").trim();

const rawFetch = globalThis.fetch as unknown as Fetchish;
const resolveChainId = gateChainId(rawFetch, api, process.env.ACR_ARC_CHAIN_ID);
const cardOpts = { privateKey: cardKey as `0x${string}`, name: "acr-mcp" as const, role: "reader" as const };
const fetchImpl = withCard(rawFetch, { ...cardOpts, chainId: resolveChainId });

/* The settlement goes out through Circle's SDK rather than our wrapped fetch, so
   the card has to be handed to it explicitly — the same reason `server.ts` has
   this function. Without it the paying probe would settle anonymous, which is a
   different thing from what a carded install actually does. */
async function extraHeaders(): Promise<Record<string, string>> {
  if (!cardKey) return {};
  try {
    const chainId = await resolveChainId();
    if (chainId === null) return {};
    return { [CARD_HEADER]: await mintCardHeader({ ...cardOpts, chainId }) };
  } catch {
    return {};
  }
}

interface Probe {
  tool: string;
  args: Record<string, unknown>;
  /** Why a non-answer is acceptable here, when it is. */
  tolerate?: (out: Record<string, unknown>) => string | null;
  /** What to SAY about an answer that passed. Separate from `tolerate` because
   *  "this passed, and here is the thing you should know about it" is not the
   *  same as "this did not answer, and here is why that is allowed". The
   *  staleness of a print is exactly that first case: a real answer worth
   *  printing an age against. */
  note?: (out: Record<string, unknown>) => string | null;
  /** True when this probe is only meaningful if the press has history for its
   *  subject — so `seen: false` means the RUN established nothing here, rather
   *  than that the tool misbehaved.
   *
   *  OPT-IN, and it has to be: the second `wallet_tca` probe below deliberately
   *  asks about a random address and `seen: false` is its passing answer. A
   *  global rule flagged that negative control as "measured nothing", which
   *  would have taught the opposite of what it is for. */
  subjectMatters?: boolean;
}

/* The two addresses `/developers` prints as its worked examples. If these come
   back empty the page is teaching a demo that demos nothing — which is what the
   7-day default window used to guarantee. */
const EXAMPLE_PAYER = "0xc2903b52a3ad365fd237b78389a2fde99e886999";
const EXAMPLE_SELLER = "0xefe0E4625AFf072c3FCff230b47f8150A17aDF19";

/** A payer and a seller this press has actually seen, read off its own tape.
 *
 *  HARDCODING ONE PAIR WAS WRONG IN A WAY THAT PASSED. `EXAMPLE_PAYER` is the
 *  mainnet deployer; against the testnet press it returns `available: true,
 *  seen: false, purchases: 0`. Two probes then lied in different directions:
 *  `wallet_tca` passed as plain `"answered"` on an all-zeros payload (it has no
 *  `tolerate`, and `verdict` only inspects `available`), and
 *  `reroute_suggestion` was excused as "no cheaper seller in this window" when
 *  the truth was "this wallet has never bought anything here" — a FALSE
 *  explained absence, which is the one kind of pass this file exists to
 *  prevent.
 *
 *  One deployment serves two chains and each has its own history, so the right
 *  address cannot be a constant. `/marketplace/receipts` is the press's own
 *  answer to "who has paid you", so the probe asks it. The documented examples
 *  stay as the fallback: on a press with no receipts at all they are still what
 *  `/developers` teaches, and a reader comparing the two should see the same
 *  addresses. */
async function subjectsFor(
  f: Fetchish,
  api: string,
): Promise<{ payer: string; seller: string; source: string }> {
  try {
    const res = await f(`${api}/marketplace/receipts?limit=25`);
    const body = (await res.json().catch(() => ({}))) as {
      receipts?: Array<{ payer?: string; seller?: string; pay_to?: string }>;
    };
    const rows = body.receipts ?? [];
    const seller = rows.find((r) => typeof (r.seller ?? r.pay_to) === "string");
    const sellerAddr = (seller?.seller ?? seller?.pay_to ?? EXAMPLE_SELLER) as string;
    const candidates = [...new Set(rows.map((r) => r.payer).filter((x): x is string => typeof x === "string"))];

    /* TAKING THE FIRST PAYER WAS STILL WRONG, and the ◌ outcome caught it on its
       first real run. `/marketplace/receipts` is the press's SETTLEMENT tape;
       `/tca/{payer}` reads the SUBGRAPH. The testnet press mirrors one into the
       other on a 120-second keeper that has been seen failing ("past the mirror
       window"), so a payer can be on the tape and genuinely absent from the
       graph — and the tape is ordered by most recent, so which payer came first
       changed between two runs minutes apart. Probing the subject before
       adopting it is the only way the choice is stable. Bounded at four, because
       this runs before every smoke. */
    for (const cand of candidates.slice(0, 4)) {
      try {
        const r = await f(`${api}/tca/${cand}?days=30`);
        const tca = (await r.json().catch(() => ({}))) as { available?: boolean; seen?: boolean };
        if (tca.available === true && tca.seen !== false) {
          return { payer: cand, seller: sellerAddr, source: "this press's receipts, confirmed on its graph" };
        }
      } catch {
        /* try the next candidate */
      }
    }
    if (candidates[0]) {
      // Nothing on the tape has reached the graph. Said, rather than papered
      // over: the ◌ outcome will report that the probe measured nothing, which
      // is the truth about this press and not a fault in the tool.
      return { payer: candidates[0], seller: sellerAddr, source: "this press's receipts, NOT yet on its graph" };
    }
  } catch {
    /* fall through to the documented pair */
  }
  return { payer: EXAMPLE_PAYER, seller: EXAMPLE_SELLER, source: "the /developers examples" };
}

function probesFor(PAYER: string, SELLER: string): Probe[] {
  return [
  {
    // The one tool that works on a bill ACR has never seen, which is the whole
    // point of it. Priced in a unit the press actually accepts.
    tool: "check_spend",
    args: { billed_usdc: 0.02, quantity: 10, unit: "$/1k tokens" },
    tolerate: (o) =>
      typeof o.reason === "string" && /predates the benchmark/.test(o.reason)
        ? "this press has no /par yet"
        : null,
  },
  {
    tool: "wallet_tca",
    args: { target: PAYER },
    subjectMatters: true,
    /* THE CONFIDENT ZERO. This probe had no guard at all, so a payer the press
       has never seen passed as `"answered"` on `purchases: 0, spent: 0`. The
       press itself distinguishes the two cases — `seen` is false when it has no
       record of the payer in the window — so the probe can too. A never-seen
       subject is a BAD subject for this probe, not a finding about the tool;
       `subjectsFor` is what stops it happening, and this is what notices if it
       does. */
    note: (o) =>
      o.seen === false
        ? `answered, but this press has never seen ${String(PAYER).slice(0, 10)}… — ` +
          "the probe is measuring nothing"
        : `seen · ${String(o.purchases)} purchases · $${String(o.spent_usdc ?? o.spent ?? "?")}`,
  },
  {
    /* THE CONFIDENT ZERO, CHECKED AGAINST A REAL TAPE. A random address has
       never bought from an ACR seller, so the press must say `seen: false` and
       not report a clean bill of health on money it never saw.

       This needs its own `tolerate` because `verdict()` below passes anything
       with `available: true` — and `available: true, purchases: 0` is exactly
       the shape being guarded against. The regression would be invisible here
       otherwise, which is how it survived this long. */
    tool: "wallet_tca",
    args: { target: `0x${Math.floor(Math.random() * 1e16).toString(16).padStart(40, "0")}` },
    tolerate: (o) => {
      /* ORDER MATTERS, and the first version got it wrong against a real
         press. `verdict()` calls this for ANY unhappy answer, so when the
         subgraph was unreachable it reported "this press predates `seen`" —
         a confident, specific and false diagnosis of a host that was running
         the newest image. An `available: false` means the tape could not be
         read at all, and nothing about `seen` can be concluded from it. */
      if (o.available === false) return null;
      if (o.seen === false) return "a wallet this tape has never seen says so";
      if (o.seen === undefined) return "this press predates `seen` — it still answers a bare zero here";
      return null;
    },
  },
  {
    /* The local half: check_spend above recorded a bill, so this must now find
       it. A stub cannot test this — it is the only probe that proves the two
       tools are wired to the same file. */
    tool: "spend_report",
    args: { days: 1 },
    tolerate: (o) =>
      typeof o.reason === "string" && /no bills have been checked/.test(o.reason)
        ? "nothing recorded — check_spend above did not reach a press with /par"
        : null,
  },
  {
    tool: "reroute_suggestion",
    args: { target: PAYER },
    subjectMatters: true,
    /* NARROWED, because the old excuse was a lie on testnet. `reroute === null`
       was accepted as "no cheaper seller in this window" — true for a payer with
       history and nothing better available, and false for a payer the press has
       never seen, where the honest sentence is "there is nothing to reroute".
       One excuse covering both let an empty probe read as a healthy one. */
    tolerate: (o) =>
      o.reroute === null
        ? o.seen === false
          ? null // the subject has no history: not an excuse, a bad subject
          : "no cheaper seller in this window"
        : null,
  },
  { tool: "seller_rating", args: { seller: SELLER } },
  {
    tool: "get_rate",
    args: { index_id: "ACR-GPU" },
    /* THIS TOLERATE COULD NOT FIRE, which is worse than not having it. It said
       "the measured state of the testnet press: its oracle has no posted
       prints" and matched `has not been posted to`. On 2026-10-10 that press
       answered ACR-GPU with a real value — so the branch did not fire, the
       probe fell through to the plain `"answered"` path, and `npm run smoke`
       reported a print **25.05 days old** as healthy.
       The 404 is still tolerated, and deliberately: measured over ten minutes
       the same press gave a value, then a 404, then the value again, because
       Arc answers `eth_getLogs` with a 429 under load. So an absence here is
       sometimes real and sometimes a throttle, and neither is a failing probe.
       What was missing is the other half — a print that EXISTS and is stale now
       gets said out loud, via `note` rather than `tolerate`, because it is a
       real answer carrying something worth knowing rather than an excused
       absence. */
    tolerate: (o) =>
      typeof o.reason === "string" && /has not been posted to/.test(o.reason)
        ? String(o.reason)
        : null,
    note: (o) =>
      o.stale === true
        ? `answered, but the print is ${String(o.age)} — ${String(o.freshness)}`
        : typeof o.value === "number"
          ? `${o.value} · ${String(o.age ?? "age unknown")}`
          : null,
  },
  {
    tool: "benchmark_price",
    args: { price: 0.02, unit: "$/1k tokens", quantity: 10 },
    tolerate: (o) =>
      typeof o.reason === "string" && /nothing to compare against|predates/.test(o.reason)
        ? "this press has no /par yet"
        : null,
  },
  { tool: "query_tape", args: { operation: "settlements", variables: { first: 3 } } },
  { tool: "can_i_pay", args: {} },
  { tool: "payment_receipts", args: { limit: 3 } },
  ];
}

function verdict(
  tool: string,
  out: unknown,
  tolerate?: Probe["tolerate"],
  note?: Probe["note"],
  subjectMatters?: Probe["subjectMatters"],
): { ok: boolean; note: string; hollow?: boolean } {
  if (!out || typeof out !== "object") return { ok: false, note: "no object came back" };
  const o = out as Record<string, unknown>;
  /* ANSWERED AND MEASURED NOTHING are different outcomes, and collapsing them is
     how "all 11 probes answered" came to be printable over a subject this press
     has never seen. Not a failure — a press with no history is a legitimate
     state, and so is a sleeping one — but it must not be counted as a pass
     either, so the summary reports it separately and the run says what it
     actually established. */
  const hollow = subjectMatters === true && o.seen === false;

  if (typeof o.error === "string") {
    return { ok: false, note: `${o.error} ${JSON.stringify(o.body ?? "").slice(0, 120)}` };
  }
  // The press's own refusal shape, which a 404 behind our wrapper also produces.
  if (typeof o.detail === "string") return { ok: false, note: `the press refused: ${o.detail}` };

  if (tool === "can_i_pay") {
    const blocked = String(o.blocked_at ?? "");
    // No payer key is the expected state for a read-only install, and the point
    // of the tool is that it says so precisely. Anything else is a real finding.
    if (blocked === "" || blocked === "payer") {
      return { ok: true, note: blocked === "payer" ? "blocked at payer (no key configured)" : "can pay" };
    }
    return { ok: false, note: `blocked at ${blocked}: ${String(o.summary ?? "")}` };
  }

  if (o.available === false) {
    const excuse = tolerate?.(o);
    if (excuse) return { ok: true, note: `not available, explained: ${excuse}` };
    return { ok: false, note: `available:false — ${String(o.reason ?? "no reason given")}` };
  }
  const excuse = tolerate?.(o);
  return { ok: true, note: excuse ?? note?.(o) ?? "answered", hollow };
}

async function main(): Promise<void> {
  console.log(`\nacr-mcp smoke · ${api}\n${"─".repeat(72)}`);

  // The deployment facts the fake gate can never supply. These are the witness:
  // they differ between one press and another, so a probe that reports them
  // cannot pass identically against a host it was never pointed at.
  const chainId = await resolveChainId();
  const chain = chainId === null ? null : arcChain(chainId);
  const who = await fetchImpl(`${api}/agent/whoami`)
    .then(async (r) => ({ status: r.status, body: (await r.json()) as { tier?: string } }))
    .catch(() => ({ status: 0, body: {} as { tier?: string } }));

  /* "UNRESOLVED" on its own reads as a network fault, which is the one thing it
     usually is not: with a card key set it most often means the chain could not
     be AGREED — the stderr line above has just named both numbers — and the
     consequence is what the reader needs, not the word. */
  console.log(
    `  gate chain id    ${chainId ?? "UNRESOLVED"}${chain ? ` (${chain.name})` : ""}` +
      (chainId === null && cardKey ? " — no card will be presented; this run is anonymous" : ""),
  );
  console.log(`  card             ${cardKey ? `configured → tier ${who.body.tier ?? "?"} (HTTP ${who.status})` : "none (anonymous)"}`);
  console.log(`  payer key        ${payerKey ? "configured" : "none — pay_and_read withheld"}`);
  console.log(`  tools offered    ${toolsFor(payerKey !== undefined).length}`);

  if (cardKey && who.status === 401) {
    console.error(
      `\n  ✖ the gate REFUSES this card (401). Every tool will fail this way.\n` +
        `    If ACR_ARC_CHAIN_ID is set, it must match ${chainId ?? "the gate's chain"}.\n`,
    );
    process.exit(1);
  }

  /* The subjects come from the press being probed, not from a constant — see
     `subjectsFor`. Printed, because which addresses a run measured is part of
     what the run established. */
  const subj = await subjectsFor(fetchImpl, api);
  const PROBES = probesFor(subj.payer, subj.seller);
  console.log(`  subjects         payer ${subj.payer.slice(0, 10)}… · seller ${subj.seller.slice(0, 10)}… (${subj.source})`);

  console.log(`${"─".repeat(72)}`);
  let failed = 0;
  let hollow = 0;
  for (const p of PROBES) {
    let out: unknown;
    try {
      out = await callTool(p.tool, p.args, { api, fetchImpl, payerKey });
    } catch (err) {
      out = { error: `threw: ${String(err).slice(0, 160)}` };
    }
    const v = verdict(p.tool, out, p.tolerate, p.note, p.subjectMatters);
    if (!v.ok) failed += 1;
    if (v.ok && v.hollow) hollow += 1;
    console.log(`  ${v.ok ? (v.hollow ? "◌" : "✔") : "✖"} ${p.tool.padEnd(20)} ${v.note}`);
  }

  /* THE PAYING PATH, BEHIND AN EXPLICIT OPT-IN. It is the only tool that
     completes the x402 loop — 402, EIP-3009 against Circle Gateway, retry, 200 —
     and the only one no probe had ever run, which is precisely the shape of gap
     this file was written to close: a stubbed `fetch` cannot refuse a card, and
     it cannot settle a payment either. Not on by default, because a smoke run
     should not cost money every time; one call, priced by the gate, inside the
     session cap. */
  if (process.env.ACR_SMOKE_PAY && payerKey) {
    console.log(`${"─".repeat(72)}`);
    const out = (await callTool("pay_and_read", { endpoint: "/prints" }, {
      api,
      fetchImpl,
      payerKey,
      extraHeaders,
    }).catch((err) => ({ paid: false, reason: `threw: ${String(err).slice(0, 200)}` }))) as {
      paid?: boolean;
      status?: number;
      paid_usdc?: number;
      settlement?: string;
      network?: string;
      reason?: string;
    };
    if (out.paid) {
      console.log(
        `  ✔ pay_and_read        HTTP ${out.status} · $${out.paid_usdc} · ${out.network} · ` +
          `settlement ${out.settlement}`,
      );
    } else {
      failed += 1;
      console.log(`  ✖ pay_and_read        ${out.reason ?? "did not pay, and gave no reason"}`);
    }
  } else if (process.env.ACR_SMOKE_PAY) {
    console.log(`  ◌ pay_and_read        ACR_SMOKE_PAY is set but no ACR_PAYER_PRIVATE_KEY is`);
  }

  console.log(`${"─".repeat(72)}`);
  if (failed > 0) {
    console.error(`  ${failed} of ${PROBES.length} tools did not answer against ${api}\n`);
    process.exit(1);
  }
  // Never "all N answered" when some of them measured nothing: the summary is
  // the line somebody quotes, so it has to be the line that is true.
  console.log(
    hollow > 0
      ? `  ${PROBES.length} probes answered · ${hollow} measured nothing (◌): this press has no ` +
        `history for the subject\n`
      : `  all ${PROBES.length} probes answered\n`,
  );
}

await main();
