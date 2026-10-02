import { NextResponse } from "next/server";
import { fetchLive } from "@/lib/api";
import type { TractionPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

/* Proxy to FastAPI /operator/traction.

   NO BUNDLE TIER, and here it matters more than anywhere else on the site.
   Every other proxy falls back to the archived snapshot when the press is cold,
   because a month-old print is still a true print. A month-old TRACTION NUMBER
   is not: it would assert a count of businesses and a volume of USDC from a
   service that is, right then, not answering. These are the figures a reviewer
   checks. The page renders the absence instead. */
export async function GET() {
  const data = await fetchLive<TractionPayload>("/operator/traction");
  return NextResponse.json(
    { live: Boolean(data), data: data ?? null, fetchedAt: Date.now() },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } },
  );
}
