import { NextResponse } from "next/server";
import { fetchLive } from "@/lib/api";
import type { BusinessesPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

/* Proxy to FastAPI /operator/businesses — who the agent runs for.

   NO BUNDLE TIER, for the same reason /api/ops has none. Every other proxy
   falls back to the archived snapshot when the press is cold, because a
   month-old print is still a true print. A month-old BUSINESS LIST is not: it
   would assert that a business is onboarded, under its name, from a service
   that is not answering. These are the numbers a reviewer checks, so the page
   renders the absence instead. */
export async function GET() {
  const data = await fetchLive<BusinessesPayload>("/operator/businesses");
  return NextResponse.json(
    { live: Boolean(data), data: data ?? null, fetchedAt: Date.now() },
    { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" } },
  );
}
