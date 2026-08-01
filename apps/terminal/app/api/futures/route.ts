import { NextResponse } from "next/server";
import { bundleSection, fetchLiveMeta } from "@/lib/api";
import { readFuturesDirect } from "@/lib/futuresOnchain";
import type { Envelope, FuturesRoster } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/* The direct-chain tier is a paced sequential RPC crawl (~6s nominal, ~12s
   worst case at 350ms spacing) — give it headroom. */
export const maxDuration = 30;

/* The live futures venue — desks + the on-chain trade tape. Fast endpoint the
   /curve desk polls (a few seconds), decoupled from the heavy /terminal/data.
   Three tiers, mirroring the terminal's connection ladder:
     press  — FastAPI /futures (its FuturesReader caches keep RPC off the path)
     chain  — direct viem reads of ACRFutures when the press is unreachable
     bundle — the archived snapshot's desks + captured tape as the floor. */
export async function GET() {
  /* 12s, not the 5s default: this endpoint's press tier can pay for an
     eth_getLogs on a throttled RPC, and giving up early falls through to the
     *slower* direct-chain crawl — or to the bundle, which reads as "the venue
     is archived" and hides the trading desk on a perfectly healthy site. */
  const { data, upstream } = await fetchLiveMeta<FuturesRoster>("/futures", 12_000);
  if (data) {
    const env: Envelope<FuturesRoster> = {
      live: true,
      data: { ...data, source: "press" },
      fetchedAt: Date.now(),
      upstream,
    };
    return NextResponse.json(env, {
      headers: { "Cache-Control": "public, s-maxage=3, stale-while-revalidate=15" },
    });
  }

  let direct: FuturesRoster | null = null;
  try {
    direct = await readFuturesDirect();
  } catch {
    /* fall through to the bundle */
  }
  if (direct) {
    // Honest live: real contract state ≤60s old, read while the press is down.
    const env: Envelope<FuturesRoster> = {
      live: true,
      data: direct,
      fetchedAt: Date.now(),
      upstream,
    };
    return NextResponse.json(env, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
    });
  }

  const bundled: FuturesRoster = {
    venue: bundleSection("chain")?.futures_address ?? null,
    desks: bundleSection("futures") ?? {},
    trades: bundleSection("futures_trades") ?? [],
    source: "bundle",
  };
  const env: Envelope<FuturesRoster> = {
    live: false,
    data: bundled,
    fetchedAt: Date.now(),
    upstream,
  };
  return NextResponse.json(env, {
    headers: { "Cache-Control": "public, s-maxage=3, stale-while-revalidate=15" },
  });
}
