import { NextResponse } from "next/server";
import { bundleSection, fetchLiveMeta } from "@/lib/api";
import { envelopeHeaders, requestChain } from "@/lib/envelope";
import type { Envelope, MarketReceiptsData } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const chain = requestChain(req);
  const { data, upstream } = await fetchLiveMeta<MarketReceiptsData>(chain, "/marketplace/receipts");
  const bundled = bundleSection(chain, "marketplace")?.receipts ?? null;
  const env: Envelope<MarketReceiptsData | null> = data
    ? { live: true, data, fetchedAt: Date.now(), chain, upstream }
    : { live: false, data: bundled, fetchedAt: Date.now(), chain, upstream };
  return NextResponse.json(env, {
    headers: envelopeHeaders("public, s-maxage=3, stale-while-revalidate=15", chain, env),
  });
}
