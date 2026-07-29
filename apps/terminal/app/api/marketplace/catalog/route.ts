import { NextResponse } from "next/server";
import { bundleSection, fetchLiveMeta } from "@/lib/api";
import type { CatalogData, Envelope } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const { data, upstream } = await fetchLiveMeta<CatalogData>("/marketplace/catalog");
  const bundled = bundleSection("marketplace")?.catalog ?? null;
  const env: Envelope<CatalogData | null> = data
    ? { live: true, data, fetchedAt: Date.now(), upstream }
    : { live: false, data: bundled, fetchedAt: Date.now(), upstream };
  return NextResponse.json(env, {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300" },
  });
}
