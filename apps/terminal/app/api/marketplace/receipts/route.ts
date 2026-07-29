import { NextResponse } from "next/server";
import { bundleSection, fetchLiveMeta } from "@/lib/api";
import type { Envelope, MarketReceiptsData } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const { data, upstream } = await fetchLiveMeta<MarketReceiptsData>("/marketplace/receipts");
  const bundled = bundleSection("marketplace")?.receipts ?? null;
  const env: Envelope<MarketReceiptsData | null> = data
    ? { live: true, data, fetchedAt: Date.now(), upstream }
    : { live: false, data: bundled, fetchedAt: Date.now(), upstream };
  return NextResponse.json(env, {
    headers: { "Cache-Control": "public, s-maxage=3, stale-while-revalidate=15" },
  });
}
