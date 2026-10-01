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
