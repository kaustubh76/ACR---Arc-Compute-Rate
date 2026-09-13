/* The buyer agent's reroute decision, ported verbatim from apps/agent/src/reroute.ts
 * so /loop can run the SAME function over the live catalog and a live TCA card
 * that the agent runs before it pays. Same inputs, same three holds, same output
 * line. Nothing here spends; it shows what the agent would do next, and why.
 *
 * Kept as a copy rather than a cross-package import because apps/agent and
 * apps/terminal are separate npm packages with separate lockfiles; the test in
 * reroute.test.ts pins this copy to the same cases the agent's own test pins.
 */

export interface RerouteSuggestion {
  from: string;
  to: string;
  saving_bp: number;
  saving_usdc: number;
}

export interface RerouteCard {
  available: boolean;
  reason?: string;
  reroute?: RerouteSuggestion | null;
}

/** A listing, as the catalog states it: the resource and who it pays. */
export interface RerouteListing {
  resource: string;
  accepts?: Array<{ payTo?: string }>;
}

export type RerouteDecision =
  | { kind: "reroute"; from: string; to: string; savingBp: number; savingUsdc: number; resource: string }
  | { kind: "hold"; reason: string };

function payTo(item: RerouteListing): string | null {
  const acc = item.accepts?.find((a) => typeof a.payTo === "string");
  return acc?.payTo ? acc.payTo.toLowerCase() : null;
}

/** Apply the card to a target list. Pure. */
export function applyReroute(
  targets: string[],
  items: RerouteListing[],
  tca: RerouteCard,
  opts: { minBp?: number } = {},
): { targets: string[]; decision: RerouteDecision } {
  const minBp = opts.minBp ?? 25;
  const hold = (reason: string) => ({ targets, decision: { kind: "hold", reason } as RerouteDecision });

  if (!tca.available) return hold(`no TCA signal yet (${tca.reason ?? "unavailable"}): buying round-robin to create one`);
  const r = tca.reroute;
  if (!r) return hold("fewer than two priced sellers on this wallet's tape: nothing to reroute between");
  if (!(r.saving_bp >= minBp)) return hold(`saving ${r.saving_bp} bp is under the ${minBp} bp threshold: staying put`);

  const to = r.to.toLowerCase();
  const from = r.from.toLowerCase();
  const byResource = new Map(items.map((i) => [i.resource, i] as const));
  const sellerOf = (t: string) => {
    const item = byResource.get(t);
    return item ? payTo(item) : null;
  };

  const preferred = targets.filter((t) => sellerOf(t) === to);
  if (preferred.length === 0) return hold(`suggested seller ${r.to} has no listing in this catalog: staying put`);
  const rest = targets.filter((t) => sellerOf(t) !== to && sellerOf(t) !== from);
  return {
    targets: [...preferred, ...rest],
    decision: { kind: "reroute", from: r.from, to: r.to, savingBp: r.saving_bp, savingUsdc: r.saving_usdc, resource: preferred[0] },
  };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The agent's own log line, byte for byte what `apps/agent --reroute` prints. */
export function describe(d: RerouteDecision): string {
  if (d.kind === "hold") return `reroute: hold — ${d.reason}`;
  let path = d.resource;
  try {
    path = new URL(d.resource).pathname;
  } catch {
    /* a bare path already */
  }
  return (
    `reroute: ${short(d.from)} → ${short(d.to)} — past fills say ${d.savingBp} bp ` +
    `(~$${d.savingUsdc.toFixed(6)}) cheaper; next payment goes to ${path}`
  );
}
