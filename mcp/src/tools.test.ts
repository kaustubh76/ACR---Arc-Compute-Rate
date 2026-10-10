import { test } from "node:test";
import assert from "node:assert/strict";

import { signAgentKitChallenge, callTool, DEFAULT_API, DEFAULT_DAYS, HUMAN_WINDOW_DAYS, TOOLS, toolsFor, UNIT_SANITY_BP } from "./tools.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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


/** A fetch stand-in that records calls and replays canned bodies. */
function fake(routes: Record<string, unknown>, seen: string[] = []) {
  return async (url: string, init?: { method?: string; body?: string }) => {
    seen.push(`${init?.method ?? "GET"} ${url}`);
    const key = Object.keys(routes).find((k) => url.includes(k));
    return {
      ok: key !== undefined,
      status: key === undefined ? 404 : 200,
      json: async () => (key === undefined ? {} : routes[key]),
    };
  };
}

test("every tool declares a schema the host can render", () => {
  for (const t of TOOLS) {
    assert.ok(t.name && t.description, `${t.name} needs a description`);
    assert.equal(t.inputSchema.type, "object");
  }
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length, "names must be unique");
});

test("wallet_tca reads the API rather than computing anything itself", async () => {
  const seen: string[] = [];
  const out = await callTool(
    "wallet_tca",
    { target: "0xabc", days: 30 },
    { api: "https://acr.test", fetchImpl: fake({ "/tca/": { available: true, vw_slippage_bp: 41 } }, seen) },
  );
  assert.deepEqual(out, { available: true, vw_slippage_bp: 41 });
  assert.equal(seen[0], "GET https://acr.test/tca/0xabc?days=30");
});

test("reroute distinguishes 'no cheaper seller' from 'tape unreadable'", async () => {
  const none = await callTool(
    "reroute_suggestion",
    { target: "0xabc" },
    { api: "https://acr.test", fetchImpl: fake({ "/tca/": { available: true, reroute: null } }) },
  );
  assert.equal((none as { reason: string }).reason, "no cheaper seller in this window");

  const down = await callTool(
    "reroute_suggestion",
    { target: "0xabc" },
    { api: "https://acr.test", fetchImpl: fake({ "/tca/": { available: false, reason: "unset" } }) },
  );
  assert.equal((down as { available: boolean }).available, false);
});

test("benchmark_price measures a quote the same way the tape measures a fill", async () => {
  const out = (await callTool(
    "benchmark_price",
    { price: 0.505, index_id: "ACR-INF" },
    { api: "https://acr.test", fetchImpl: fake({ "/onchain/": { value: 0.5 } }) },
  )) as { slippage_bp: number; arrival: number };
  assert.equal(out.arrival, 0.5);
  assert.equal(out.slippage_bp, 100); // +1% == +100 bp
});

test("benchmark_price refuses to compare against a print that does not exist", async () => {
  const out = (await callTool(
    "benchmark_price",
    { price: 0.5, index_id: "ACR-INF" },
    { api: "https://acr.test", fetchImpl: fake({ "/onchain/": {} }) },
  )) as { available: boolean };
  assert.equal(out.available, false);
});

test("query_tape lists the allowlist when called with no operation", async () => {
  const seen: string[] = [];
  await callTool("query_tape", {}, {
    api: "https://acr.test",
    fetchImpl: fake({ "/graph/operations": { operations: ["meta"] } }, seen),
  });
  assert.equal(seen[0], "GET https://acr.test/graph/operations");
});

test("query_tape posts an operation name, never query text", async () => {
  let body = "";
  const out = await callTool("query_tape", { operation: "meta" }, {
    api: "https://acr.test",
    fetchImpl: async (url: string, init?: { method?: string; body?: string }) => {
      body = init?.body ?? "";
      return { ok: true, status: 200, json: async () => ({ available: true }) };
    },
  });
  assert.deepEqual(JSON.parse(body), { operation: "meta", variables: {} });
  assert.deepEqual(out, { available: true });
});

test("an unknown tool names the ones that exist", async () => {
  const out = (await callTool("nope", {}, { fetchImpl: fake({}) })) as { tools: string[] };
  assert.ok(out.tools.includes("wallet_tca"));
});

/** The human gate: `/humanid/info` states the rotation window, then `/tca/human`
 *  answers a 401 carrying a nonce, then the answer.
 *
 *  ROUTED BY PATH, NOT BY CALL COUNT, and that mattered. This stub used to
 *  return the 401 to whichever request arrived first — so when `humanTca` began
 *  asking `/humanid/info` for the window (because `DEFAULT_DAYS` of 30 is a
 *  window `/tca/human` cannot answer), the info request consumed the challenge
 *  and every assertion about the sequence shifted by one. A stub that answers by
 *  arrival order agrees with the press only as long as nobody adds a request.
 *
 *  `windowDays: null` simulates a press whose info route states no window at
 *  all, which is the case the local refusal must NOT act on. */
function humanGate(
  union: unknown,
  seen: Array<{ url: string; headers?: Record<string, string> }> = [],
  opts: { windowDays?: number | null } = {},
) {
  let tcaCalls = 0;
  return async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, headers: init?.headers });
    if (url.includes("/humanid/info")) {
      const body = opts.windowDays === null ? {} : { rotation_window_days: opts.windowDays ?? 7 };
      return { ok: true, status: 200, json: async () => body };
    }
    tcaCalls += 1;
    if (tcaCalls === 1) {
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: "human proof required", nonce: "n0nce" }),
      };
    }
    return { ok: true, status: 200, json: async () => union };
  };
}

/** Just the `/tca/human` calls, which is what the sequence assertions are about. */
const tcaCalls = (seen: Array<{ url: string; headers?: Record<string, string> }>) =>
  seen.filter((c) => c.url.includes("/tca/human"));

test('wallet_tca("me") answers the challenge rather than reusing a static credential', async () => {
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  const out = await callTool(
    "wallet_tca",
    { target: "me", days: 7 },
    {
      api: "https://acr.test",
      fetchImpl: humanGate({ available: true, human: { wallet_count: 3 } }, seen),
      nullifier: "0xnull",
    },
  );
  // `window_days` rides on every human answer: a caller who named no window
  // would otherwise read a 7-day figure as the 30-day one every other tool
  // returns. Here the window WAS named, and it is echoed.
  assert.deepEqual(out, { available: true, human: { wallet_count: 3 }, window_days: 7 });
  // Two calls to the gate: take a challenge, then answer THAT nonce. The nonce
  // is single-use, so a credential held across calls would stop working.
  const gated = tcaCalls(seen);
  assert.equal(gated.length, 2);
  assert.equal(gated[0].url, "https://acr.test/tca/human?days=7");
  assert.equal(gated[1].headers?.["HUMAN-PROOF"], "humanid 0xnull:n0nce");
});

test('wallet_tca("me") asks the window the press can answer, not DEFAULT_DAYS', async () => {
  /* THE BUG, FOUND AGAINST THE LIVE TESTNET PRESS 2026-10-10. `DEFAULT_DAYS` is
     30 — widened from 7 because at 7 every wallet and seller reported zero rows.
     `/tca/human` cannot answer 30: a human's wallet set is resolved per rotation
     window, and the press refuses anything longer. So this tool, and
     `reroute_suggestion({target:"me"})`, could not succeed at their own defaults
     — ever. The proof was minted, the gate accepted it, and the request was then
     refused over an argument the plugin chose itself.
     No stub could catch it: the gate above answers `available: true` whatever
     `days` says. The third time in this package that a fake gate refused
     nothing. */
  assert.equal(DEFAULT_DAYS, 30, "if this changes, re-read why the human path cannot use it");
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  await callTool(
    "wallet_tca",
    { target: "me" }, // no `days` — the path that was broken
    { api: "https://acr.test", fetchImpl: humanGate({ available: true }, seen, { windowDays: 7 }), nullifier: "0xnull" },
  );
  for (const call of tcaCalls(seen)) {
    assert.ok(call.url.includes("days=7"), `asked for ${call.url}, which the press cannot answer`);
    assert.ok(!call.url.includes("days=30"), "DEFAULT_DAYS must never reach /tca/human");
  }
});

test("the window comes from the press, not from a constant here", async () => {
  /* `HUMAN_WINDOW_DAYS` is a fallback for an unreadable info route, not the
     answer. A deployment that rotates on a different cadence must be followed,
     or this plugin narrows someone's history for no reason. */
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  await callTool(
    "wallet_tca",
    { target: "me" },
    { api: "https://acr.test", fetchImpl: humanGate({ available: true }, seen, { windowDays: 3 }), nullifier: "0xnull" },
  );
  assert.ok(tcaCalls(seen).every((c) => c.url.includes("days=3")), "the press said 3; we asked 3");
  assert.notEqual(HUMAN_WINDOW_DAYS, 3, "the fallback must not be what made this pass");
});

test("an over-window ask is refused before a credential is minted", async () => {
  /* A proof is single-use and cheap but not free, and the press's refusal is
     knowable in advance once it has stated its window. So: no challenge, no
     signature, and a sentence that names the number to ask for. */
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  const out = (await callTool(
    "wallet_tca",
    { target: "me", days: 30 },
    { api: "https://acr.test", fetchImpl: humanGate({ available: true }, seen, { windowDays: 7 }), nullifier: "0xnull" },
  )) as { available: boolean; reason: string; window_days: number };
  assert.equal(out.available, false);
  assert.equal(out.window_days, 7);
  assert.match(out.reason, /7-day rotation window/);
  assert.match(out.reason, /Ask for 7 or fewer/);
  assert.match(out.reason, /pass an address instead/, "the longer history is still reachable, and says how");
  assert.equal(tcaCalls(seen).length, 0, "nothing was asked of the gate, so no nonce was spent");
});

test("an unstated window DEFERS to the press rather than refusing on a guess", async () => {
  /* The half that keeps the local refusal honest. If the info route says
     nothing, our 7 is an assumption — and refusing a 30-day ask on an
     assumption would deny a window some other deployment genuinely allows. The
     press's own sentence is a good one; let it speak. */
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  const out = (await callTool(
    "wallet_tca",
    { target: "me", days: 30 },
    { api: "https://acr.test", fetchImpl: humanGate({ available: true }, seen, { windowDays: null }), nullifier: "0xnull" },
  )) as { available: boolean };
  assert.equal(out.available, true, "the request went through to the press");
  assert.ok(tcaCalls(seen).length > 0, "the gate was asked");
  assert.ok(tcaCalls(seen).every((c) => c.url.includes("days=30")), "and asked for what the caller wanted");
});

test('reroute_suggestion({target:"me"}) goes through the same window', async () => {
  // Same helper, same bug, and it would have been missed by fixing only
  // wallet_tca: both cases call `humanTca`.
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  await callTool(
    "reroute_suggestion",
    { target: "me" },
    {
      api: "https://acr.test",
      fetchImpl: humanGate({ available: true, reroute: null }, seen, { windowDays: 7 }),
      nullifier: "0xnull",
    },
  );
  assert.ok(tcaCalls(seen).every((c) => c.url.includes("days=7")));
});

test('wallet_tca("me") sends the credential in a header, never in the URL', async () => {
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  await callTool(
    "wallet_tca",
    { target: "me" },
    { api: "https://acr.test", fetchImpl: humanGate({ available: true }, seen), nullifier: "0xsecret" },
  );
  for (const call of seen) {
    assert.ok(!call.url.includes("0xsecret"), "a nullifier in a URL lands in every access log");
  }
});

test('wallet_tca("me") says why it cannot answer, rather than looking unverified-but-fine', async () => {
  const out = (await callTool(
    "wallet_tca",
    { target: "me" },
    { api: "https://acr.test", fetchImpl: humanGate({ available: true }) },
  )) as { available: boolean; reason: string };
  assert.equal(out.available, false);
  // A dev gate with no nullifier: say which credential is missing. (The AgentKit
  // gate's answer is pinned separately — it names ACR_HUMAN_AGENT_KEY.)
  assert.match(out.reason, /ACR_HUMAN_NULLIFIER/);
});

test('wallet_tca with an address does not touch the human gate', async () => {
  const seen: string[] = [];
  await callTool(
    "wallet_tca",
    { target: "0xabc" },
    { api: "https://acr.test", fetchImpl: fake({ "/tca/": { available: true } }, seen) },
  );
  assert.equal(seen[0], `GET https://acr.test/tca/0xabc?days=${DEFAULT_DAYS}`);
});

test('reroute_suggestion("me") reroutes the fleet as one book', async () => {
  const out = await callTool(
    "reroute_suggestion",
    { target: "me" },
    {
      api: "https://acr.test",
      fetchImpl: humanGate({ available: true, reroute: { from: "0xdear", to: "0xcheap" } }),
      nullifier: "0xnull",
    },
  );
  assert.deepEqual(out, { from: "0xdear", to: "0xcheap" });
});

test("with a key, every tool's upstream call carries an agent card", async () => {
  /* This server is an agent calling ACR and was, for a day, the only caller in the
     repo presenting nothing. One wrap around the shared fetch covers every tool,
     including query_tape's direct POST, because they all go through the same `f`. */
  const { withCard } = await import("./card.js");
  const seenHeaders: Array<Record<string, string> | undefined> = [];
  const inner = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    seenHeaders.push(init?.headers);
    return { ok: true, status: 200, json: async () => ({ operations: ["meta"], available: true, data: {} }) };
  };
  const f = withCard(inner, { privateKey: `0x${"11".repeat(32)}`, chainId: 5042002 });
  await callTool("query_tape", {}, { api: "https://acr.test", fetchImpl: f });
  await callTool("query_tape", { operation: "meta" }, { api: "https://acr.test", fetchImpl: f });
  assert.equal(seenHeaders.length, 2);
  for (const h of seenHeaders) {
    assert.ok(h?.["AGENT-CARD"], "every upstream call must carry the card");
    assert.ok(h["AGENT-CARD"].length > 200, "and it must be a real base64 card, not a placeholder");
  }
  // No key: the fetch is returned UNCHANGED, so anonymous costs nothing extra.
  const bare = withCard(inner, { chainId: 5042002 });
  assert.equal(bare, inner);
});


test('wallet_tca("me") signs an AgentKit challenge when the gate asks for one', async () => {
  /* Production runs the AgentKit verifier; the dev-gate nullifier format was met
     with "malformed agentkit header". With a wallet key lent by the host the
     plugin signs the CAIP-122 message the verifier recovers. */
  const { recoverMessageAddress, privateKeyToAccount } = await import("viem/accounts").then(async (a) => ({
    ...a,
    ...(await import("viem")),
  }));
  const key = `0x${"42".repeat(32)}`;
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  // Routed by path, for the reason `humanGate` above spells out.
  let gated = 0;
  const gate = async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, headers: init?.headers });
    if (url.includes("/humanid/info")) {
      return { ok: true, status: 200, json: async () => ({ rotation_window_days: 7 }) };
    }
    gated += 1;
    if (gated === 1) {
      return {
        ok: false,
        status: 401,
        json: async () => ({ scheme: "agentkit", nonce: "n0nce", header: "HUMAN-PROOF", resource: "/tca/human" }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ available: true, human: { wallet_count: 3 } }) };
  };
  const out = (await callTool("wallet_tca", { target: "me" }, { api: "https://acr.test", fetchImpl: gate, humanKey: key })) as {
    available: boolean;
  };
  assert.equal(out.available, true);
  const header = tcaCalls(seen)[1].headers?.["HUMAN-PROOF"];
  assert.ok(header, "the proof rides in the header the challenge named");
  const payload = JSON.parse(Buffer.from(header!, "base64").toString()) as {
    address: `0x${string}`; nonce: string; uri: string; signedMessage: string; signature: `0x${string}`;
  };
  assert.equal(payload.nonce, "n0nce");
  assert.equal(payload.uri, "/tca/human");
  assert.match(payload.signedMessage, /Nonce: n0nce/);
  const who = await recoverMessageAddress({ message: payload.signedMessage, signature: payload.signature });
  assert.equal(who, privateKeyToAccount(key as `0x${string}`).address);
  assert.equal(payload.address, who);
});

test('wallet_tca("me") against an AgentKit gate with no key says what to set', async () => {
  const gate = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ scheme: "agentkit", nonce: "n", header: "HUMAN-PROOF" }),
  });
  const out = (await callTool("wallet_tca", { target: "me" }, { api: "https://acr.test", fetchImpl: gate, nullifier: "0xdev" })) as {
    available: boolean; reason: string;
  };
  assert.equal(out.available, false);
  assert.match(out.reason, /ACR_HUMAN_AGENT_KEY/);
  assert.ok(typeof signAgentKitChallenge === "function");
});

// ───────────────────────────────────────── the package's own claims about itself

test("the version the server reports is the version npm publishes", () => {
  /* TWO COPIES OF ONE NUMBER. `server.ts` hands a literal to the MCP handshake,
     which is what a host displays, and `package.json` carries the one npm
     pins. Nothing connected them, so a release could ship 0.3.0 while every
     host on earth was told 0.2.0 — and the symptom would be a bug report about
     a version that was never published.

     Pinned here rather than read at runtime: an MCP server that touches the
     filesystem during startup has a new way to fail before it can report
     anything, and the handshake is the one message that must always go out. */
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as { version: string };
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "server.ts"), "utf8");
  const declared = /name: "acr-tca", version: "([^"]+)"/.exec(src)?.[1];
  assert.equal(declared, pkg.version, "server.ts and package.json disagree about the version");
});

test("the README's stated tool count is the number of tools there are", () => {
  /* NOTHING GATED THE PROSE. `mcpsnippet.test.ts` pins the terminal's tool
     NAMES against this file, but the counts written in English drifted
     independently — `mcp/README.md` said "Ten tools" on line 3 and "eight of
     the nine" twenty-four lines later, contradicting itself in the one
     document npm renders as the package page. */
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
  const words: Record<string, number> = {
    Nine: 9, Ten: 10, Eleven: 11, Twelve: 12, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const claims = [...readme.matchAll(/\b(Nine|Ten|Eleven|Twelve|nine|ten|eleven|twelve)\b/g)].map(
    (m) => words[m[1]],
  );
  assert.ok(claims.length > 0, "the README states no tool count at all");
  const wrong = claims.filter((n) => n !== TOOLS.length && n !== TOOLS.length - 1);
  assert.deepEqual(
    wrong,
    [],
    `the README names ${JSON.stringify(wrong)} where there are ${TOOLS.length} tools ` +
      `(${TOOLS.length - 1} of them reads)`,
  );
});
