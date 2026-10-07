import { NextResponse } from "next/server";
import { fetchLiveMeta, postLiveMeta } from "@/lib/api";
import { countHumans, currentWindow } from "@/lib/humans";
import type { HumanClusterRow, HumanIdData, HumanIdInfo } from "@/lib/humans";
import type { Envelope } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Who the benchmark is secured by, and what "verified" means in this deployment.
 *
 * Two upstream reads, each independently allowed to fail, because they answer
 * different questions and one is useful without the other:
 *
 *   /humanid/info   what the gate IS — backend, rotation window, Sandbox flag.
 *                   Read rather than hardcoded so the footer cannot keep
 *                   claiming a gate an operator has since switched away from.
 *   graph `humans`  who is resolved on the tape right now.
 *
 * THE RULE THIS ROUTE EXISTS TO ENFORCE: an unread tape is `null`, never `0`.
 * "The press is down" and "nobody is verified" are different facts, and a
 * benchmark that renders them the same has started lying about its own
 * security. `countHumans` returns null for a null input for this reason, and
 * nothing here coerces it.
 */

/** The proxy's own ceiling (graph_proxy.MAX_FIRST). Asking for more is refused. */
const FIRST = 200;
const OP_TIMEOUT_MS = 9_000;

interface ProxyEnvelope<T> {
  available: boolean;
  reason?: string;
  data?: T;
}

async function op<T>(operation: string, variables: Record<string, unknown> = {}) {
  const { data } = await postLiveMeta<ProxyEnvelope<T>>(
    "/graph/query",
    { operation, variables },
    OP_TIMEOUT_MS,
  );
  return data?.available ? (data.data ?? null) : null;
}

export async function GET() {
  const [infoRes, metaRes, clusterRes] = await Promise.all([
    fetchLiveMeta<HumanIdInfo>("/humanid/info", OP_TIMEOUT_MS),
    op<{ _meta: { block: { timestamp: number } } }>("meta"),
    op<{ humanClusters: HumanClusterRow[] }>("humans", { first: FIRST }),
  ]);

  const rows = clusterRes?.humanClusters ?? null;

  /* Chain time, not server time. The window a cluster id was minted for is a
     fact about the chain's clock; deriving it from ours would, within a few
     minutes of a 7-day boundary, look for ids in a window nobody has minted yet
     and report the benchmark as secured by nobody. HumanIdMirrorClient's
     chain_window() refuses the local clock for exactly this reason. Our clock is
     the fallback only when the tape did not answer — in which case `rows` is
     null and the count is null regardless, so the window is unused. */
  const chainNow = metaRes?._meta?.block?.timestamp;
  const window = currentWindow(Number(chainNow ?? Date.now() / 1000));

  const data: HumanIdData = {
    info: infoRes.data,
    humans: countHumans(rows, window),
    // A full page may be a truncated one. The strip prints "200+" rather than a
    // confident exact number it cannot stand behind.
    truncated: rows != null && rows.length >= FIRST,
  };

  // `live` is the freshness claim about the COUNT, not merely that this route
  // returned 200: /humanid/info answering while the tape is dark would
  // otherwise badge a stale N as current.
  const live = data.humans != null;
  const env: Envelope<HumanIdData> = {
    live,
    data,
    fetchedAt: Date.now(),
    upstream: live ? "ok" : infoRes.upstream,
  };
  return NextResponse.json(env, {
    headers: {
      // A 7-day window does not change quickly; the Sandbox flag does not change
      // at all. Cached harder than the tape, which turns over every block.
      "Cache-Control": live ? "public, s-maxage=60, stale-while-revalidate=300" : "no-store",
    },
  });
}
