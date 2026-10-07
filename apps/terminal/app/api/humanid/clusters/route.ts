import { NextResponse } from "next/server";
import { postLiveMeta } from "@/lib/api";
import { currentWindow, type ClusterRow, type ClustersData } from "@/lib/humans";
import type { Envelope } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* GET /api/humanid/clusters — who is one person this window, as the tape records it.
 *
 * `/api/humanid` counts; this lists, so /loop can DRAW each cluster as a ring of
 * wallet dots. Public tape data throughout: HumanIdMirror records cluster ids
 * (keccak of a nullifier, the salt and the window — never the nullifier) and the
 * wallets resolved to them, and the subgraph indexes exactly that. Nothing here
 * can be walked back to a person.
 */

interface RawCluster {
  id: string;
  window: string;
  sandbox: boolean;
  walletCount?: number;
  wallets?: { id: string; settlementCount?: string | number }[];
}

export async function GET() {
  const [metaRes, humansRes] = await Promise.all([
    postLiveMeta<{ data?: { _meta?: { block?: { timestamp?: number } } } }>("/graph/query", { operation: "meta" }, 8000),
    postLiveMeta<{ available: boolean; data?: { humanClusters?: RawCluster[] } }>(
      "/graph/query",
      { operation: "humans", variables: { first: 100 } },
      8000,
    ),
  ]);
  const blockTime = metaRes.data?.data?._meta?.block?.timestamp ?? null;
  const window = currentWindow(Number(blockTime ?? Date.now() / 1000));
  const raw = humansRes.data?.data?.humanClusters ?? null;
  const clusters: ClusterRow[] | null = raw
    ? raw
        .map((c) => ({
          id: c.id,
          window: Number(c.window),
          sandbox: Boolean(c.sandbox),
          wallets: (c.wallets ?? []).map((w) => ({ id: w.id.toLowerCase(), settlements: Number(w.settlementCount ?? 0) })),
        }))
        .sort((a, b) => b.window - a.window || b.wallets.length - a.wallets.length)
    : null;

  const env: Envelope<ClustersData | null> = {
    live: clusters != null,
    data: clusters ? { window, blockTime, clusters } : null,
    fetchedAt: Date.now(),
    upstream: clusters != null ? "ok" : humansRes.upstream,
  };
  return NextResponse.json(env, { headers: { "Cache-Control": "no-store" } });
}
