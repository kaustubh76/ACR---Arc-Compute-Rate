import { NextResponse } from "next/server";
import { fetchLive } from "@/lib/api";
import type { LedgerAudit } from "@/lib/types";

export const dynamic = "force-dynamic";

/* Proxy to FastAPI /operator/audit/{business}.

   Same guard, same reason, same shape as the statement proxy beside it: the
   param becomes a path segment upstream, so it is validated here rather than
   interpolated and hoped over. */
const BUSINESS = /^(0x[0-9a-fA-F]{40}|[a-z0-9][a-z0-9-]{0,40})$/;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const business = (url.searchParams.get("business") ?? "").trim();
  if (!BUSINESS.test(business)) {
    return NextResponse.json(
      { live: false, data: null, fetchedAt: Date.now(), error: "bad business" },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  const raw = Number(url.searchParams.get("days") ?? 90);
  const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.trunc(raw))) : 90;

  const data = await fetchLive<LedgerAudit>(
    `/operator/audit/${encodeURIComponent(business)}?days=${days}`,
  );
  return NextResponse.json(
    { live: Boolean(data), data: data ?? null, fetchedAt: Date.now() },
    // No cache. A findings list is the one thing on this site where a stale
    // "clean" is worse than no answer: it would report a book as checked that
    // nobody has checked since the last payment.
    { headers: { "Cache-Control": "no-store" } },
  );
}
