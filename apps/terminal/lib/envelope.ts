/* One envelope, built in one place, stamped with the chain that answered.
 *
 * WHY THIS FILE EXISTS. Forty-two route handlers hand-rolled
 * `{live, data, fetchedAt}` literals, and none of them took a `Request` — so
 * there was nowhere for a per-visitor fact to enter. That was fine while there
 * was one chain and one audience. It stops being fine twice over:
 *
 *   - one deployment now serves two chains, and the chain has to reach both the
 *     response body (so the client can verify it) and the cache directive (so a
 *     non-default chain is never stored in a shared cache);
 *   - the operator surfaces need to forward a caller's agent card upstream,
 *     which also needs the inbound request.
 *
 * Both wants are the same want: the handler must see the request and stamp what
 * it saw. Doing that once here is why 42 copies of the same three keys became
 * one function with a test.
 *
 * Pure and dependency-light on purpose: `npm test` runs only `lib/*.test.ts`, so
 * a decision living inside a route handler is a decision no test can reach — the
 * same argument `lib/readResult.ts` and `lib/sellerLadder.ts` already make.
 */

import { CHAIN_COOKIE, CHAIN_PARAM, resolveChain, type ChainKey } from "./chainChoice";
import { sharedCache } from "./readResult";
import type { Envelope } from "./types";

/** The chain this request is for.
 *
 *  An explicit `?chain=` wins over the cookie, and the cookie over the default.
 *  The param has to win: a URL carrying `chain=testnet` may be answered from a
 *  shared cache, so it must never be served from the rig a particular visitor's
 *  cookie happens to name.
 *
 *  Reads the cookie off the header rather than through `next/headers` so this
 *  module stays importable by a unit test — `cookies()` throws outside a request
 *  scope, and `npm test` has none.
 */
export function requestChain(req: Request): ChainKey {
  let param: string | null = null;
  try {
    param = new URL(req.url).searchParams.get(CHAIN_PARAM);
  } catch {
    /* a handler invoked without a parseable URL falls through to the cookie */
  }
  return resolveChain(param, cookieValue(req.headers.get("cookie"), CHAIN_COOKIE));
}

/** One cookie out of a `Cookie` header, or null.
 *
 *  Hand-parsed rather than pulled from a dependency because the header is one
 *  line of grammar and this file is imported by route handlers on the hot path.
 *  Splits on the first `=` only: a cookie value may contain one.
 */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** A stamped envelope. `chain` is not optional here even though the type allows
 *  it: a response that cannot say which chain it is from is one the client must
 *  refuse, and the way to never ship one is to make the builder demand it. */
export function envelope<T>(
  data: T,
  opts: { live: boolean; chain: ChainKey; upstream?: Envelope<T>["upstream"] },
): Envelope<T> {
  return {
    live: opts.live,
    data,
    fetchedAt: Date.now(),
    chain: opts.chain,
    ...(opts.upstream ? { upstream: opts.upstream } : {}),
  };
}

/** The headers for a read, with the chain deciding whether it may be shared.
 *
 *  `directive` is the shared directive this route has always used. On the default
 *  chain it is returned unchanged, so nothing about today's caching moves. On any
 *  other chain it becomes `private, no-store`, because Vercel's CDN keys a stored
 *  response on method and URL and not on cookies — measured on the live
 *  deployment, two sequential GETs of /api/terminal returned `x-vercel-cache:
 *  MISS` then `HIT`.
 *
 *  That alone is NOT sufficient and must not be mistaken for the fix: it stops a
 *  non-default response being stored, and does nothing to stop a non-default
 *  request being answered from an entry already stored under the same URL. Only a
 *  different URL does that, which is why `apiKey()` puts the chain in the query of
 *  every client fetch. Both halves, or neither works.
 */
export function chainHeaders(directive: string, chain: ChainKey): Record<string, string> {
  return { "Cache-Control": sharedCache(directive, chain) };
}

/** The headers for a refusal: never cached, on any chain.
 *
 *  Serving one failed read from the CDN for ten seconds turns a transient blip
 *  into a shared, confident lie — every visitor in that window gets the same
 *  wrong state and the retry that would have fixed it never reaches the origin.
 *  Spelled out rather than composed from `chainHeaders` so no future edit can
 *  make a refusal cacheable by changing a directive somewhere else.
 */
export function refusalHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store" };
}
