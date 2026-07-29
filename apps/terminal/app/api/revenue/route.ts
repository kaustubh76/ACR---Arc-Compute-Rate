import { NextResponse } from "next/server";
import { bundleSection, fetchLiveMeta } from "@/lib/api";
import { PRICE_FALLBACK_USDC } from "@/lib/indices";
import type { Envelope, RevenueData } from "@/lib/types";

export const dynamic = "force-dynamic";

const OFFLINE: RevenueData = { paid_queries: 0, revenue_usdc: 0, price_usdc: PRICE_FALLBACK_USDC, recent: [] };

export async function GET() {
  const { data, upstream } = await fetchLiveMeta<RevenueData>("/revenue");
  const env: Envelope<RevenueData> = data
    ? { live: true, data, fetchedAt: Date.now(), upstream }
    : { live: false, data: bundleSection("revenue") ?? OFFLINE, fetchedAt: Date.now(), upstream };
  return NextResponse.json(env, {
    headers: { "Cache-Control": "public, s-maxage=3, stale-while-revalidate=15" },
  });
}
