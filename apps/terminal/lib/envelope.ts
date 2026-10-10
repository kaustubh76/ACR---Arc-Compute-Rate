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

import { CARD_HEADER, MAX_CARD } from "./agentcard";
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

/** The caller's agent card, ready to spread into an upstream `fetch` — or `{}`.
 *
 *  THE CARD IS NEVER IN A URL, and that is the whole reason this is a header on
 *  the hop rather than a query parameter the client could have appended. A card
 *  is a bearer credential: a URL is written to access logs, kept in a browser's
 *  history, sent in a `Referer`, and — the one that matters here — is the ONLY
 *  thing Vercel's CDN keys a stored response on. A card in the query string
 *  would therefore be both leaked and, worse, the key under which one reader's
 *  private statement got stored for the next reader. `lib/cardForwarding.test.ts`
 *  is the gate that keeps it out.
 *
 *  ABSENT, MALFORMED AND OVERLONG ALL BECOME "NO CARD", deliberately: the press
 *  is the only thing that may judge a card, so this hop does not get to invent a
 *  reason. It either forwards what it was given or forwards nothing, and the
 *  press answers the 401 that names what to claim.
 *
 *  The length cap is `MAX_CARD`, shared with the probe. A header is attacker-set
 *  and this one is copied into an outbound request, so an unbounded one is an
 *  unbounded request we make on somebody else's say-so.
 */
export function cardHeader(req: Request): Record<string, string> {
  const card = (req.headers.get(CARD_HEADER) ?? "").trim();
  if (!card || card.length > MAX_CARD) return {};
  /* STANDARD base64's alphabet, `+/` and not `-_`. Both encoders are plain
     base64 — `base64.b64encode` in agentcard.py, `btoa` in lib/agentcard.ts —
     and I first wrote this as base64url, which would have refused any card
     containing a `+` or a `/` before the press ever saw it.

     It passed 200 of 200 real minted cards, which is the part worth recording:
     a `+` needs a byte at a position ≡2 mod 3 to be `>` or `~`, and a card's
     JSON is hex addresses, a slug and a signature. So the bug was invisible to
     every test I would have written, and waiting on the first card whose `name`
     carried one of four characters. Measured, not reasoned about — and then
     fixed by matching what the encoders emit rather than keeping a cap that
     happened to hold.

     The property actually wanted is narrower than the alphabet: no CR, no LF,
     no control characters, nothing that can split the upstream request this
     value is copied into. */
  if (!/^[A-Za-z0-9+/=]+$/.test(card)) return {};

  /* AND IT MUST LOOK LIKE A CARD. Hex is a subset of base64's alphabet, so a
     charset check alone forwards `0x` + sixty-four hex characters — a private
     key — into an upstream request and an upstream log. A card is base64 of
     `{"card":…`, so it begins `eyJ`. Same rule as `normaliseCard` in
     lib/readerCard.ts, which is where the measurement is recorded. */
  if (!card.startsWith("eyJ")) return {};
  return { [CARD_HEADER]: card };
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

/** The same, but a FALLBACK is never cached.
 *
 *  THE RULE IS NOT NEW — `readHeaders` in lib/readResult.ts has stated it since
 *  it was written: "a failed read must NEVER be cached. Serving one throttled
 *  answer from the CDN for ten seconds turns a transient blip into a shared,
 *  confident lie — every visitor in that window gets the same wrong state, and
 *  the retry that would have fixed it never reaches the origin." Three routes
 *  followed it. Eleven had a single exit that sent the cacheable directive
 *  whatever the envelope said.
 *
 *  MEASURED, on the deployed site: `/api/terminal?chain=mainnet` answered
 *  `live: false` on three consecutive reads with an identical `fetchedAt`,
 *  serving an archived ACR-INF print **12.13 days old**, while that press had a
 *  print 55 minutes old and answered directly in 0.65s. Its `/terminal/data`
 *  measured 180s (hung), 34.1s, then 0.65s across three calls against a 5000ms
 *  budget — so a cold Render start loses, the cushion is correct, and caching
 *  the cushion is what turned one lost race into the front page for everyone
 *  for the next ~35 seconds.
 *
 *  IT TAKES THE ENVELOPE, NOT A BOOLEAN, deliberately. A boolean is a thing you
 *  can pass the wrong way round and never notice, and this particular mistake
 *  does not fail loudly — it caches a lie and looks fine. The envelope already
 *  knows.
 *
 *  Only the default chain was ever exposed: `sharedCache` downgrades the other
 *  to `private, no-store` already. Confirmed live — every testnet route answered
 *  `private, no-store` and every mainnet one `public`.
 */
export function envelopeHeaders(
  directive: string,
  chain: ChainKey,
  env: { live: boolean },
): Record<string, string> {
  return env.live ? chainHeaders(directive, chain) : { "Cache-Control": "no-store" };
}

/** The headers for an upstream refusal this hop is passing through.
 *
 *  A 401 WITHOUT `WWW-Authenticate` IS NOT A 401. RFC 9110 requires the header
 *  on a 401, it is how a client learns which scheme to use, and the press
 *  already sends `AgentCard` — so dropping it at the proxy would turn a
 *  well-formed challenge into a bare refusal one hop from the browser. Measured:
 *  the ledger proxy forwarded it and the two JSON proxies did not, which is the
 *  kind of difference nothing notices until a client follows the spec.
 *
 *  Never cached, for the reason `refusalHeaders` gives.
 */
export function passthroughRefusalHeaders(authenticate?: string): Record<string, string> {
  return { ...refusalHeaders(), ...(authenticate ? { "WWW-Authenticate": authenticate } : {}) };
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
