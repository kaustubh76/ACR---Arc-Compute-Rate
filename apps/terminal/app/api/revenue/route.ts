import { NextResponse } from "next/server";
import { bundleSection, fetchLiveMeta } from "@/lib/api";
import { envelopeHeaders, requestChain } from "@/lib/envelope";
import { PRICE_FALLBACK_USDC } from "@/lib/indices";
import type { Envelope, RevenueData } from "@/lib/types";

export const dynamic = "force-dynamic";

const OFFLINE: RevenueData = { paid_queries: 0, revenue_usdc: 0, price_usdc: PRICE_FALLBACK_USDC, recent: [] };

export async function GET(req: Request) {
  const chain = requestChain(req);
  const { data, upstream } = await fetchLiveMeta<RevenueData>(chain, "/revenue");
  const env: Envelope<RevenueData> = data
    ? { live: true, data, fetchedAt: Date.now(), chain, upstream }
    : { live: false, data: bundleSection(chain, "revenue") ?? OFFLINE, fetchedAt: Date.now(), chain, upstream };
  return NextResponse.json(env, {
    headers: envelopeHeaders("public, s-maxage=3, stale-while-revalidate=15", chain, env),
  });
}
