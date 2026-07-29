/* The single source of truth for the index roster and gate pricing fallback.
   Client- and server-safe: no imports, no side effects. Adding an index here
   propagates to the console, the registry switcher, the endpoints table, the
   buy allowlist, and the console proxy's SSRF allowlist. */

export const INDICES = ["ACR-INF", "ACR-GPU", "ACR-DATA"] as const;

export type IndexId = (typeof INDICES)[number];

export function isIndexId(s: string): s is IndexId {
  return (INDICES as readonly string[]).includes(s);
}

/* Fallback per-query price when /x402/info is unreachable — the gate's real
   price (ACR_X402_PRICE_USDC) always wins when readable. */
export const PRICE_FALLBACK_USDC = 0.0001;
