/* The single source of truth for the index roster and gate pricing fallback.
   Client- and server-safe: no imports, no side effects. Adding an index here
   propagates to the console, the registry switcher, the endpoints table, the
   buy allowlist, and the console proxy's SSRF allowlist. */

export const INDICES = ["ACR-INF", "ACR-GPU", "ACR-DATA"] as const;

export type IndexId = (typeof INDICES)[number];

export function isIndexId(s: string): s is IndexId {
  return (INDICES as readonly string[]).includes(s);
}

/* The UNIT each index prices, which is what `/par` takes — it benchmarks a bill
   per unit of service, and the index id never appears in that query at all.
   These three strings are `_PRICEABLE_UNITS` in the press, derived there from
   the same roster (`spec_for(i).unit for i in ALL_INDEX_IDS`), and the press
   422s anything else.

   Here because the header above promises this file is the single source of
   truth for the roster and a second list of units elsewhere would be a second
   thing to keep in step. Ordered to match INDICES, so a picker built from
   either reads the same way.

   NOTE `$` and `/` are both significant in a query string, so every caller
   percent-encodes: `unit=%24%2F1k%20tokens`. */
export const UNITS = ["$/1k tokens", "$/GPU-sec", "$/MB"] as const;

export type Unit = (typeof UNITS)[number];

export function isUnit(s: string): s is Unit {
  return (UNITS as readonly string[]).includes(s);
}

/* Which index answers for a unit. One direction only: a unit identifies an
   index, and the reverse lookup is `UNIT_OF`. Both are derived from the same
   pair of tuples rather than written out, so they cannot disagree. */
export const UNIT_OF: Record<IndexId, Unit> = Object.fromEntries(
  INDICES.map((id, i) => [id, UNITS[i]]),
) as Record<IndexId, Unit>;

export const INDEX_FOR_UNIT: Record<Unit, IndexId> = Object.fromEntries(
  UNITS.map((u, i) => [u, INDICES[i]]),
) as Record<Unit, IndexId>;

/* Fallback per-query price when /x402/info is unreachable — the gate's real
   price (ACR_X402_PRICE_USDC) always wins when readable. */
export const PRICE_FALLBACK_USDC = 0.0001;
