/* Where the seller lives, when nothing says otherwise.
 *
 * Eight places used to spell `process.env.NEXT_PUBLIC_ACR_API ?? "http://127.0.0.1:8000"`,
 * and that default is wrong in the one place it actually gets used: a production
 * build on a server, where localhost:8000 is nothing at all. The live terminal
 * shipped pointing at a host that cannot exist, and the only thing hiding it was
 * an environment variable someone had to remember to set.
 *
 * So the fallback follows the build: a production bundle falls back to the
 * production seller, development keeps localhost. `NEXT_PUBLIC_ACR_API` still
 * wins over both, which is how a fork, a preview or a testnet deployment points
 * somewhere else — nothing here constrains them.
 *
 * Client-safe on purpose. Next inlines `NEXT_PUBLIC_*` and `NODE_ENV` into client
 * bundles and does NOT inline `ACR_API`, so that server-only variable is read in
 * `lib/api.ts` instead, where it can be. This module stays dependency-free for
 * the same reason `lib/rpcErrors.ts` does: `lib/api.ts` imports `fallback.json`
 * (141 KB) and must never be pulled into the browser.
 */

/** The deployed mainnet seller. A literal, because a build has no other way to
 *  learn it, and public — it is in the README and in every x402 receipt. */
export const MAINNET_SELLER = "https://acr-api-mainnet.onrender.com";

/** The local seller `make api` serves. */
export const LOCAL_SELLER = "http://127.0.0.1:8000";

/** The seller base for BROWSER-side code (wallet payments talk to it directly,
 *  so it must be a real host rather than a same-origin proxy path). */
export function sellerBase(): string {
  const explicit = process.env.NEXT_PUBLIC_ACR_API?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  return process.env.NODE_ENV === "production" ? MAINNET_SELLER : LOCAL_SELLER;
}

/** The seller THIS BUILD knows is right, consulting no environment variable.
 *
 *  Deliberately not `sellerBase()`. The cushion below exists for the case where
 *  a configured host is dead — and `ACR_API` and `NEXT_PUBLIC_ACR_API` were both
 *  set to the SAME suspended service, so deriving the cushion from either one
 *  collapsed the candidate list to a single dead host and the fallback could
 *  never fire. Measured on the live deployment: `fellBack: false` with `active`
 *  still naming the dead host. A cushion has to come from somewhere the broken
 *  configuration cannot reach.
 */
export function publishedSeller(): string {
  return process.env.NODE_ENV === "production" ? MAINNET_SELLER : LOCAL_SELLER;
}

/** Which seller bases to try, in order.
 *
 *  The configured override comes first and a working one is never overridden.
 *  The build's published seller follows it as a cushion, because an `ACR_API`
 *  naming a decommissioned host once demoted every route on the live terminal
 *  to the archived bundle for two days. Deduped: with no override, or an
 *  override that already equals the published base, there is one candidate and
 *  no fallback behaviour at all.
 */
export function sellerCandidates(configured: string, published: string): string[] {
  const c = configured.trim().replace(/\/$/, "");
  const p = published.trim().replace(/\/$/, "");
  if (!c) return [p];
  return c === p ? [c] : [c, p];
}

/** Whether a response means "this host is not serving" rather than "no".
 *
 *  5xx only. A 402 is the paywall working, a 404 is "no open series for this
 *  index" — both are the seller answering correctly, and trying a different
 *  host because of one would be a bug, not a cushion.
 */
export function isHostFailure(status: number): boolean {
  return status >= 500;
}
