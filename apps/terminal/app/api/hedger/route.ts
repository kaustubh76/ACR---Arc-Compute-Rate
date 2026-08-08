import { NextResponse } from "next/server";
import { bundleSection, fetchLiveMeta } from "@/lib/api";
import type { Envelope, HedgerState } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* The autonomous hedger's standing — mandate, position, fills, spend.

   Two tiers, not three. The press derives this from the chain and the
   settlement ledger together, and there is no direct-viem tier because the
   spend half lives in the ledger rather than on-chain: a chain-only read would
   show the agent's trades while silently reporting its payments as zero, which
   is precisely the "absent looks like empty" failure this codebase keeps
   meeting. Better to fall straight to the archived snapshot, which is honestly
   labelled stale, than to serve a half-true live-looking answer. */
export async function GET() {
  const { data, upstream } = await fetchLiveMeta<HedgerState>("/hedger", 8_000);
  if (data) {
    const env: Envelope<HedgerState> = {
      live: true,
      data,
      fetchedAt: Date.now(),
      upstream,
    };
    return NextResponse.json(env, {
      headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=20" },
    });
  }

  const archived = bundleSection("hedger") as HedgerState | undefined;
  const env: Envelope<HedgerState> = {
    live: false,
    data:
      archived ?? {
        configured: false,
        agent: null,
        payer: null,
        index_id: "ACR-INF",
        target_contracts: 0,
        venue: null,
        wallet_kind: "circle-agent-wallet",
        series_id: null,
        multiplier: null,
        mark: null,
        mark_block: null,
        position_contracts: null,
        gap_contracts: null,
        collateral_usdc: null,
        paid_queries: null,
        spent_usdc: null,
        fills: [],
        receipts: null,
      },
    fetchedAt: Date.now(),
    upstream,
  };
  return NextResponse.json(env, {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
  });
}
