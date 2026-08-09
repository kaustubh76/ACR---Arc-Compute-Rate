/* "We could not read this" is not a value.
 *
 * Every bug this module forecloses is the same sentence: a value meaning *the
 * read failed* got stored, cached, rendered and reasoned about as if it meant
 * *zero / empty / flat*. Measured on production before it was written:
 *
 *   - GET /api/desk/fills returned {"fills":[]} on 1 of 5 probes for a wallet
 *     with four fills on the series. Arc served the same query in 0.29s, so
 *     the chain was fine; the empty array was a swallowed failure, and it read
 *     as "this reader has never traded".
 *   - A throttled position read returned null, was served 200 with
 *     s-maxage=10, clobbered a good position in React state, and rendered as
 *     "flat" — telling a reader holding a position that they hold nothing, and
 *     serving that answer from the CDN to everyone for ten seconds.
 *
 * The template for getting it right was already in the codebase:
 * futuresOnchain's `seriesMultiplier` returns a sentinel with the comment "a 1x
 * figure is wrong, so the caller must not show it". This makes that discipline
 * a type instead of a comment.
 *
 * Pure on purpose: `npm test` runs only lib/*.test.ts, so a decision that
 * lives inside a .tsx or a route handler is a decision nobody can assert on.
 */

export type Read<T> = { ok: true; value: T } | { ok: false; why: string };

export function ok<T>(value: T): Read<T> {
  return { ok: true, value };
}

/** A read that did not happen. `why` is a short stable scope, not a message. */
export function unread<T>(why: string): Read<T> {
  return { ok: false, why };
}

/** Cache headers for a read's response.
 *
 *  A failed read must NEVER be cached. Serving one throttled answer from the
 *  CDN for ten seconds turns a transient blip into a shared, confident lie —
 *  every visitor in that window gets the same wrong state, and the retry that
 *  would have fixed it never reaches the origin.
 */
export function readHeaders(r: Read<unknown>): Record<string, string> {
  return r.ok
    ? { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" }
    : { "Cache-Control": "no-store" };
}

/** Cache headers for a read whose whole product is that it is fresh.
 *
 *  `readHeaders` is right for the reads a page makes on the reader's behalf: a
 *  10s shared cache is most of the origin load gone for an answer nobody asked
 *  for twice. It is wrong for a button. Measured on production the day
 *  /api/registry/keys shipped: two presses nine seconds apart came back
 *  byte-identical, same block AND same took_ms, under `x-vercel-cache: STALE`
 *  with `age: 12`. `stale-while-revalidate=30` means the edge will replay one
 *  answer for up to forty seconds, and Arc mines a block every 0.51s, so a
 *  reader pressing "read it from the chain" twice was being shown a recording.
 *
 *  Both registry routes' comments already promised the opposite ("a second
 *  press must be able to report a later block, or the button is theatre"), so
 *  the header was contradicting the file it lived in. A press is a deliberate
 *  act, not a poll; paying one origin round trip for it is the deal.
 */
export function freshHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store" };
}

/** 200 for an answer, 503 for "ask again".
 *
 *  503 rather than 200-with-a-null so a client's ordinary error path handles
 *  it: PublicDesk's fetch helper already throws on !res.ok into a catch that
 *  keeps the last good value, so the honest status does most of the client
 *  work for free.
 */
export function readStatus(r: Read<unknown>): number {
  return r.ok ? 200 : 503;
}

/** The value to keep in state after a read.
 *
 *  An unread result must not overwrite what we already knew. This is the whole
 *  fix for "a throttled poll told a reader they were flat": the previous
 *  position is stale, but stale-and-true beats fresh-and-invented.
 */
export function keepLast<T>(prev: T, r: Read<T>): T {
  return r.ok ? r.value : prev;
}

/** Whether a result deserves a place in a memo.
 *
 *  Caching a failure means one throttled call decides the answer for the whole
 *  memo window — the 15s position memo did exactly that, so a single blip made
 *  a reader "flat" for fifteen seconds no matter how often they polled.
 */
export function shouldMemo(r: Read<unknown>): boolean {
  return r.ok;
}

/** One stable line for a swallowed read failure.
 *
 *  Returned as a string rather than logged here so the FORMAT is testable —
 *  the call site does `console.error(readFailure(...))`. The bug that prompted
 *  this had no log line at all, so a production failure left nothing behind to
 *  find: the runtime logs were simply empty, which read as "nothing went
 *  wrong".
 */
export function readFailure(scope: string, ctx: Record<string, unknown>, e?: unknown): string {
  const parts = Object.entries(ctx).map(([k, v]) => `${k}=${String(v)}`);
  const err = e instanceof Error ? e.message : e == null ? "" : String(e);
  return `acr.read.fail scope=${scope}${parts.length ? " " + parts.join(" ") : ""}${
    err ? ` err=${err.slice(0, 160).replace(/\s+/g, " ")}` : ""
  }`;
}
