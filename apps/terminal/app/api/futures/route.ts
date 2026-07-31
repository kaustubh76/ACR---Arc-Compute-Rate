import { NextResponse } from "next/server";
import { bundleSection, fetchLiveMeta } from "@/lib/api";
import type { Envelope, FuturesRoster } from "@/lib/types";

export const dynamic = "force-dynamic";

/* The live futures venue — desks + the on-chain trade tape. Fast endpoint the
   /curve desk polls (a few seconds), decoupled from the heavy /terminal/data.
   Falls back to the bundled desks (no tape) when the press is unreachable. */
export async function GET() {
  const { data, upstream } = await fetchLiveMeta<FuturesRoster>("/futures");
  const bundled: FuturesRoster = {
    venue: bundleSection("chain")?.futures_address ?? null,
    desks: bundleSection("futures") ?? {},
    trades: [],
  };
  const env: Envelope<FuturesRoster> = data
    ? { live: true, data, fetchedAt: Date.now(), upstream }
    : { live: false, data: bundled, fetchedAt: Date.now(), upstream };
  return NextResponse.json(env, {
    headers: { "Cache-Control": "public, s-maxage=3, stale-while-revalidate=15" },
  });
}
