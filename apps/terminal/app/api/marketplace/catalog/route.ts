import { NextResponse } from "next/server";
import { bundleSection, fetchLiveMeta } from "@/lib/api";
import { chainHeaders, requestChain } from "@/lib/envelope";
import type { CatalogData, Envelope } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const chain = requestChain(req);
  const { data, upstream } = await fetchLiveMeta<CatalogData>(chain, "/marketplace/catalog");
  const bundled = bundleSection(chain, "marketplace")?.catalog ?? null;
  const env: Envelope<CatalogData | null> = data
    ? { live: true, data, fetchedAt: Date.now(), chain, upstream }
    : { live: false, data: bundled, fetchedAt: Date.now(), chain, upstream };
  return NextResponse.json(env, {
    headers: chainHeaders("public, s-maxage=30, stale-while-revalidate=300", chain),
  });
}
