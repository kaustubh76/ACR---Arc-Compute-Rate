import { NextRequest, NextResponse } from "next/server";
import { readOracleDirect } from "@/lib/onchain";
import type { Envelope, OnchainDirectRead } from "@/lib/types";

/* Settlement-grade prints read straight from ACROracle with viem — answers
   even when the FastAPI press is cold. Cached at the CDN: prints move hourly,
   so one RPC round serves every visitor in the window. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Paced RPC reads (the public Arc RPC throttles bursts): a history read takes
// ~12s worst case — give the function headroom beyond Vercel's 10s default.
export const maxDuration = 30;

const CACHE = "public, s-maxage=30, stale-while-revalidate=300";

export async function GET(req: NextRequest) {
  // ?history=<index-id> also reads the last 12 on-chain prints for that index.
  const historyFor = req.nextUrl.searchParams.get("history");
  let data: OnchainDirectRead | null = null;
  try {
    data = await readOracleDirect(historyFor);
  } catch (e) {
    console.warn("[terminal] direct oracle read failed:", (e as Error).message);
  }
  const env: Envelope<OnchainDirectRead | null> = {
    live: data != null,
    data,
    fetchedAt: Date.now(),
    upstream: data != null ? "ok" : "error",
  };
  return NextResponse.json(env, { headers: { "Cache-Control": CACHE } });
}
