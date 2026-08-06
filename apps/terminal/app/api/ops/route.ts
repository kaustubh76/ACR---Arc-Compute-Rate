import { NextResponse } from "next/server";
import { fetchLive } from "@/lib/api";
import type { OpsLedger } from "@/lib/types";

export const dynamic = "force-dynamic";

/* Proxy to FastAPI /ops/verify — the systems ledger.

   DELIBERATELY has no bundle tier. Every other proxy here falls back to the
   archived snapshot when the press is cold, because a month-old print is still
   a true print. A month-old VERDICT is not: "all pillars live" read off a
   bundle would assert the health of a service that is, right then, not
   answering. The page renders the absence instead. */
export async function GET() {
  const data = await fetchLive<OpsLedger>("/ops/verify");
  return NextResponse.json(
    {
      live: Boolean(data),
      data: data ?? null,
      fetchedAt: Date.now(),
    },
    // Short cache: the ledger only recomputes every 15 minutes upstream, so
    // this exists to spare the press repeated proxying, not to hide staleness
    // (the payload carries its own `at`, which the page renders).
    { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" } },
  );
}
