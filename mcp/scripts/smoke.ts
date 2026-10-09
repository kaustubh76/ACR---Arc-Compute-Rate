/** Every tool, against a real press. The check the unit suite cannot be.
 *
 *   npm run smoke                                     # the default host
 *   ACR_API=https://acr-api-mainnet.onrender.com npm run smoke
 *   ACR_AGENT_PRIVATE_KEY=0x… npm run smoke           # also exercise the card
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

import { gateChainId, withCard } from "../src/card.js";
import { arcChain } from "../src/chain.js";
import { callTool, DEFAULT_API, toolsFor, type Fetchish } from "../src/tools.js";

const api = (process.env.ACR_API ?? DEFAULT_API).replace(/\/$/, "");
const payerKey = (process.env.ACR_PAYER_PRIVATE_KEY ?? "").trim() || undefined;
const cardKey = (process.env.ACR_AGENT_PRIVATE_KEY ?? "").trim();

const rawFetch = globalThis.fetch as unknown as Fetchish;
const resolveChainId = gateChainId(rawFetch, api, process.env.ACR_ARC_CHAIN_ID);
const fetchImpl = withCard(rawFetch, {
  privateKey: cardKey as `0x${string}`,
  name: "acr-mcp",
  role: "reader",
  chainId: resolveChainId,
});

interface Probe {
  tool: string;
  args: Record<string, unknown>;
  /** Why a non-answer is acceptable here, when it is. */
  tolerate?: (out: Record<string, unknown>) => string | null;
}

/* The two addresses `/developers` prints as its worked examples. If these come
   back empty the page is teaching a demo that demos nothing — which is what the
   7-day default window used to guarantee. */
const PAYER = "0xc2903b52a3ad365fd237b78389a2fde99e886999";
const SELLER = "0xefe0E4625AFf072c3FCff230b47f8150A17aDF19";

const PROBES: Probe[] = [
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
  { tool: "my_tca", args: { target: PAYER } },
  {
    tool: "reroute_suggestion",
    args: { target: PAYER },
    tolerate: (o) => (o.reroute === null ? "no cheaper seller in this window" : null),
  },
  { tool: "seller_rating", args: { seller: SELLER } },
  {
    tool: "get_rate",
    args: { index_id: "ACR-GPU" },
    // The measured state of the testnet press: its oracle has no posted prints.
    // A named, explained absence is a pass; a bare HTTP error is not.
    tolerate: (o) => (typeof o.reason === "string" && /has not been posted to/.test(o.reason) ? String(o.reason) : null),
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

function verdict(tool: string, out: unknown, tolerate?: Probe["tolerate"]): { ok: boolean; note: string } {
  if (!out || typeof out !== "object") return { ok: false, note: "no object came back" };
  const o = out as Record<string, unknown>;

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
  return { ok: true, note: excuse ?? "answered" };
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

  console.log(`  gate chain id    ${chainId ?? "UNRESOLVED"}${chain ? ` (${chain.name})` : ""}`);
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

  console.log(`${"─".repeat(72)}`);
  let failed = 0;
  for (const p of PROBES) {
    let out: unknown;
    try {
      out = await callTool(p.tool, p.args, { api, fetchImpl, payerKey });
    } catch (err) {
      out = { error: `threw: ${String(err).slice(0, 160)}` };
    }
    const v = verdict(p.tool, out, p.tolerate);
    if (!v.ok) failed += 1;
    console.log(`  ${v.ok ? "✔" : "✖"} ${p.tool.padEnd(20)} ${v.note}`);
  }

  console.log(`${"─".repeat(72)}`);
  if (failed > 0) {
    console.error(`  ${failed} of ${PROBES.length} tools did not answer against ${api}\n`);
    process.exit(1);
  }
  console.log(`  all ${PROBES.length} probes answered\n`);
}

await main();
