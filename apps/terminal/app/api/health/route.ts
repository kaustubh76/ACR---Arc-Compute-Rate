import { NextResponse } from "next/server";
import { fetchLive } from "@/lib/api";
import type { HealthData } from "@/lib/types";

export const dynamic = "force-dynamic";

/* Proxy to FastAPI /health — the gate/chain/poster mode oracle. Offline the
   data is null and the UI honestly reads SIM · ARCHIVED. */
export async function GET() {
  const data = await fetchLive<HealthData>("/health");
  return NextResponse.json(
    {
      live: Boolean(data),
      data: data ?? null,
      fetchedAt: Date.now(),
    },
    { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=60" } },
  );
}
