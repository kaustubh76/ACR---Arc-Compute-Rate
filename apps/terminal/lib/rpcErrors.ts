/* Is an RPC refusal about the SIZE of the range, or about us?
 *
 * The distinction is load-bearing. Narrowing cures a too-wide window and does
 * nothing for a throttle — measured once, treating a 429 as "too wide" walked
 * the cursor forward and turned a four-page 7.9h reach into 1264 blocks.
 *
 * Arc MAINNET refuses in TWO ways (measured 2026-09-28) where testnet had one:
 *   -32602  "query exceeds max results 2000, retry with the range A-B" — a
 *           RESULT cap, which even names the range to retry with.
 *   -32012  "requested range too large" — a BLOCK cap. Address-filtered, 5000
 *           blocks answer and 10000 do not.
 * Both arrive as a JSON-RPC error inside an HTTP 200; rapid-fire requests get a
 * bare 403 instead, which is rate limiting and looks nothing like either.
 *
 * It lives here rather than in futuresOnchain.ts because that module imports
 * `server-only` and so cannot be pulled into a test. */
export function isRangeError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  if (/429|Too Many Requests/i.test(msg)) return false;
  return /413|Payload Too Large|-32602|-32012|exceeds max results|range too large|limit exceeded/i.test(msg);
}

/** Is this refusal the node telling us to slow down?
 *
 *  A DIFFERENT QUESTION FROM `isRangeError`, AND IT HAS TO BE ASKED SEPARATELY.
 *  Note the overlap trap: Arc answers a paced-too-fast `eth_call` with
 *  `-32005 "rate limit exceeded"`, whose text contains "limit exceeded" — the
 *  phrase `isRangeError` matches on. That is correct for `eth_getLogs`, where
 *  the phrase means a result cap, and wrong for a plain call, where it means us.
 *  So this is checked FIRST by anything that can be throttled, and the two are
 *  never collapsed into one predicate.
 *
 *  WHY IT MATTERS MORE THAN IT LOOKS. A throttled read and an absent value are
 *  opposite facts that arrive through the same `catch`. Measured against the
 *  live float vault: nine of eleven reads came back throttled and rendered as a
 *  treasury with no sleeves, no agents and no policy — a confident, readable,
 *  entirely wrong screen. "I could not read this" has to survive as its own
 *  answer, which starts with being able to name it.
 */
export function isThrottled(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown; cause?: unknown } | null;
  const msg = String(err?.message ?? e);
  const nested = String((err?.cause as { message?: unknown } | undefined)?.message ?? "");
  const both = `${msg} ${nested}`;
  if (err?.code === -32005) return true;
  /* A BARE 403 IS ARC'S OTHER THROTTLE SHAPE, and this file's own notes above
     already said so: "rapid-fire requests get a bare 403 instead, which is rate
     limiting and looks nothing like either." Measured again on the float vault,
     where a burst of `eth_call` went from `-32005` to HTTP 403 with no body.
     Including it means a keyed RPC refusing our credentials is retried three
     times before we believe it, which is three calls to learn something we
     cannot fix either way; omitting it means a throttle renders as a treasury
     with nothing in it, which is a wrong screen a reader will act on. */
  return /-32005|rate limit|rate-limit|429|Too Many Requests|too many requests|\b403\b|Forbidden/i.test(both);
}
