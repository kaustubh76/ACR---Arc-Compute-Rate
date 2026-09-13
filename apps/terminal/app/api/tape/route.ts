import { currentWindow } from "@/lib/humans";
import { NextResponse } from "next/server";
import { fetchLiveMeta, postLiveMeta } from "@/lib/api";
import type { Envelope } from "@/lib/types";
import { humanShareInWindow, sellersFromSettlements, recentForPayer } from "@/lib/tape";
import type {
  GraphTransport,
  SellerRating,
  TapeData,
  TapeMeta,
  TapeSeller,
  TapeSettlement,
  TcaResult,
} from "@/lib/tape";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* The indexed tape — what an agent paid, against what it could have seen.
 *
 * Every figure here exists only because the subgraph computed it: `slippageBp`
 * is produced inside the mapping from an arrival snapshot of indexed prints, so
 * there is no chain-only tier to fall back to and no bundled tier either. That
 * is deliberate, and it is the same rule /ops follows: a month-old print is
 * still a true print, but a month-old MEASUREMENT of how well an agent traded
 * is not — it would be read as current. When the tape cannot be reached this
 * route says so and the page renders the reason.
 *
 * Four upstream reads, in parallel, each independently allowed to fail:
 *   meta          the freshness proof the whole claim rests on
 *   sellers       the directory (works even while /rating is down)
 *   settlements   used only to find who has been trading
 *   futuresFills  the control group — zero slippage BY CONSTRUCTION
 */

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

/** The payer this page is about.
 *
 * Not hardcoded to our own buyer: the busiest payer on the recent tape is the
 * one worth showing, and an explicit ?payer= always wins. A hardcoded address
 * would quietly keep pointing at us after anyone else started trading. */
function busiestPayer(rows: TapeSettlement[]): string | null {
  const counts = new Map<string, number>();
  for (const s of rows) {
    const id = s?.payer?.id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [id, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = id;
  return best;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const payerParam = url.searchParams.get("payer");

  const [rawMeta, sellersRes, settleRes, fills, opsRes] = await Promise.all([
    op<{ _meta: { block: { number: number; timestamp: number }; hasIndexingErrors: boolean; deployment: string } }>(
      "meta",
    ),
    op<{ sellers: TapeSeller[] }>("sellers", { first: 50 }),
    op<{ settlements: TapeSettlement[] }>("settlements", { first: 200 }),
    op<{ fills: { slippageBp: string | null; benchmarked: boolean }[] }>("futuresFills", {
      first: 200,
    }),
    fetchLiveMeta<{ transport?: GraphTransport }>("/graph/operations", OP_TIMEOUT_MS),
  ]);

  const settlements = settleRes?.settlements ?? [];
  const payer = payerParam ? payerParam.toLowerCase() : busiestPayer(settlements);

  /* Flattened at the boundary. `_meta.block` is a nested object and TapeMeta is
     flat: leaving the nesting to the view would have rendered an object through
     a number formatter, which is the shape of every "confident wrong value"
     bug this codebase keeps finding. */
  const meta: TapeMeta | null = rawMeta?._meta
    ? {
        block: rawMeta._meta.block.number,
        timestamp: rawMeta._meta.block.timestamp,
        hasIndexingErrors: rawMeta._meta.hasIndexingErrors,
        deployment: rawMeta._meta.deployment,
      }
    : null;

  /* Prefer the `sellers` operation — it is the subgraph's own rollup and carries
     the quality record. Fall back to grouping the settlements when it cannot
     answer, which is not hypothetical: it gained a relation the deployed
     subgraph does not have and now returns nothing at all. Either way the
     numbers come from the same indexed tape, and `slippageBp` is still the
     mapping's, computed against an arrival snapshot. */
  // The primary path carries per-window rollups, so the human share is read off the
  // window the CHAIN is in — the same clock /api/humanid uses and for the same
  // reason: a host clock near a 7-day boundary would look in a window nobody has
  // settled in yet and report every seller as human-free.
  const chainNow = rawMeta?._meta?.block?.timestamp;
  const window = currentWindow(Number(chainNow ?? Date.now() / 1000));
  const sellers: TapeSeller[] = sellersRes?.sellers?.length
    ? sellersRes.sellers.map((s) => ({ ...s, humanShare: humanShareInWindow(s.windows, window) }))
    : sellersFromSettlements(settlements);

  /* The control group, counted rather than asserted. ACRFutures fills at
     `oracle.latestValue`, so a fill's price IS its own arrival price and its
     slippage can only ever be zero. Counting the non-zero ones is how the page
     earns the right to call it a control: if this number is ever not zero, the
     claim is wrong and the page should stop making it. */
  const control = fills
    ? {
        fills: fills.fills.filter((f) => f.benchmarked).length,
        nonZero: fills.fills.filter((f) => f.benchmarked && Number(f.slippageBp ?? 0) !== 0).length,
      }
    : null;

  const tcaRes = payer
    ? await fetchLiveMeta<TcaResult>(`/tca/${payer}?days=7`, OP_TIMEOUT_MS)
    : { data: null, upstream: "error" as const };

  /* Grades are an ENHANCEMENT, not a dependency. /rating reaches for a window
     entity the deployed subgraph may not carry yet, and when it cannot answer
     the directory is still worth reading — volume, counts and freshness all
     come from `sellers`. A missing letter is rendered as a missing letter. */
  const ratings: Record<string, SellerRating> = {};
  await Promise.all(
    sellers.slice(0, 12).map(async (s) => {
      const { data } = await fetchLiveMeta<SellerRating>(`/rating/${s.id}?days=7`, OP_TIMEOUT_MS);
      if (data) ratings[s.id.toLowerCase()] = data;
    }),
  );

  const data: TapeData = {
    meta,
    tca: tcaRes.data,
    recent: recentForPayer(settlements, payer),
    transport: opsRes.data?.transport ?? null,
    sellers,
    ratings,
    control,
    payer,
  };

  // `live` means the tape answered — the freshness claim, not merely that this
  // route returned 200. A page told `live: true` over a null meta would badge
  // an outage as current.
  const env: Envelope<TapeData> = {
    live: meta != null,
    data,
    fetchedAt: Date.now(),
    upstream: meta != null ? "ok" : tcaRes.upstream,
  };
  return NextResponse.json(env, {
    headers: {
      "Cache-Control": meta
        ? "public, s-maxage=15, stale-while-revalidate=60"
        : "no-store",
    },
  });
}
