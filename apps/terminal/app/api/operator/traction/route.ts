import { NextResponse } from "next/server";
import { fetchLiveMeta } from "@/lib/api";
import type { TractionPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

/* Proxy to FastAPI /operator/traction.

   NO BUNDLE TIER, and here it matters more than anywhere else on the site.
   Every other proxy falls back to the archived snapshot when the press is cold,
   because a month-old print is still a true print. A month-old TRACTION NUMBER
   is not: it would assert a count of businesses and a volume of USDC from a
   service that is, right then, not answering. These are the figures a reviewer
   checks. The page renders the absence instead.

   AND IT COULD NOT, because this route answered 200 with `data: null`. The
   symptom differed from /spend's and that is worth writing down: /traction's
   empty branch is `t && t.businesses.businesses === 0`, which needs a non-null
   payload, so on 200/null it rendered NOTHING AT ALL — not a falsehood, a blank
   section where the figures should be. Same cause, and 503 is the same fix,
   because it is what makes the view's error branch reachable.

   See `operator/businesses/route.ts` for why 503, why `upstream` is stamped and
   why the timeout is 12s rather than the 5000ms default.

   THE CACHE HEADER IS GONE FROM THE REFUSAL PATH. It was
   `s-maxage=60, stale-while-revalidate=120` unconditionally, so an edge that
   caught the press mid-sleep would keep serving that emptiness for two minutes
   after it woke. A successful read still caches; a failed one never does. */
export async function GET() {
  const { data, upstream } = await fetchLiveMeta<TractionPayload>(
    "/operator/traction",
    12_000,
  );
  if (!data) {
    return NextResponse.json(
      { live: false, data: null, fetchedAt: Date.now(), upstream, error: "the press did not answer" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { live: true, data, fetchedAt: Date.now(), upstream },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } },
  );
}
