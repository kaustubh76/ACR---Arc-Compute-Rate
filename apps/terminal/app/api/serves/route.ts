import { NextResponse } from "next/server";
import { servedPaths } from "@/lib/api";
import { chainHeaders, envelope, requestChain } from "@/lib/envelope";

export const dynamic = "force-dynamic";

/* Which routes the press behind this chain actually has.
 *
 * WHY A PAGE NEEDS TO ASK. `/developers` advertises runnable endpoints from
 * `lib/endpoints.ts`, which describes what the PRODUCT serves and is pinned
 * against `app.openapi()` by tests/test_endpoint_register_parity.py. That
 * register is correct. The deployment behind it can still be older — measured
 * on 2026-10-10, the mainnet press served 44 routes and none of `/par` or the
 * five `/operator/*` — so the page offered a `run` button that could only ever
 * return 404. Its own register says "a row that explains itself wrongly is
 * worse than one that says nothing", and the page says "Not a button that
 * could only ever fail". This is how it finds out which rows those are.
 *
 * NOT A REASON TO EDIT THE REGISTER. Availability is per host and changes
 * without a commit; what the product serves is a property of the code. Folding
 * the first into the second would make the register lie about the product in
 * order to describe one deployment.
 *
 * Reads the same cached `/openapi.json` the `absent` detection already uses
 * (`specFor` in lib/api.ts), so this adds a reader rather than a fetch.
 *
 * `data: null` means the host would not say, which is NOT "serves nothing":
 * the page then offers everything, exactly as it did before this route
 * existed. Absence of evidence is not evidence.
 */
export async function GET(req: Request) {
  const chain = requestChain(req);
  const paths = await servedPaths(chain);
  return NextResponse.json(envelope(paths, { live: paths !== null, chain }), {
    // Slow-moving: a deployment's route set changes on a redeploy, not on a
    // request. Cached longer than a reading, and still revalidated, so the
    // page stops advertising a route within the minute of it appearing.
    headers: chainHeaders("public, s-maxage=60, stale-while-revalidate=300", chain),
  });
}
