import { NextResponse } from "next/server";
import { fetchLive } from "@/lib/api";
import type { Statement } from "@/lib/types";

export const dynamic = "force-dynamic";

/* Proxy to FastAPI /operator/statement/{business}.

   THE PARAM BECOMES A PATH SEGMENT upstream, so it is validated here rather
   than interpolated and hoped over. A registry slug or a 0x address, nothing
   else: that rejects `..`, a slash, and a query of its own before any of them
   reach the press. `app/api/ops/actions/route.ts` rebuilds its body for the
   same reason, and the rule there is the rule here — only what the shape
   allows ever leaves this file. */
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

  // Clamped rather than passed through: a window nobody asked for is a slow
  // query somebody can ask for repeatedly.
  const raw = Number(url.searchParams.get("days") ?? 7);
  const days = Number.isFinite(raw) ? Math.min(90, Math.max(1, Math.trunc(raw))) : 7;

  const data = await fetchLive<Statement>(
    `/operator/statement/${encodeURIComponent(business)}?days=${days}`,
  );
  return NextResponse.json(
    { live: Boolean(data), data: data ?? null, fetchedAt: Date.now() },
    // No cache: the escalation queue is the part of this page somebody is
    // waiting on, and a cached one would show an approval that already happened.
    { headers: { "Cache-Control": "no-store" } },
  );
}
