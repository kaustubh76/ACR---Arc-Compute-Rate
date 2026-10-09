import { NextResponse } from "next/server";
import { fetchLiveMeta } from "@/lib/api";
import { cardHeader, passthroughRefusalHeaders, refusalHeaders, requestChain } from "@/lib/envelope";
import type { LedgerAudit } from "@/lib/types";

export const dynamic = "force-dynamic";

/* Proxy to FastAPI /operator/audit/{business}.

   Same guard, same reason, same shape as the statement proxy beside it: the
   param becomes a path segment upstream, so it is validated here rather than
   interpolated and hoped over. */
const BUSINESS = /^(0x[0-9a-fA-F]{40}|[a-z0-9][a-z0-9-]{0,40})$/;

export async function GET(req: Request) {
  const chain = requestChain(req);
  const url = new URL(req.url);
  const business = (url.searchParams.get("business") ?? "").trim();
  if (!BUSINESS.test(business)) {
    return NextResponse.json(
      { live: false, data: null, fetchedAt: Date.now(), chain, error: "bad business" },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  const raw = Number(url.searchParams.get("days") ?? 90);
  const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.trunc(raw))) : 90;

  // Forwarded and passed through, for the same reasons as the statement proxy
  // beside it — a findings list is per-business detail, so it is gated the same
  // way and refused with the same sentence.
  const { data, refusal, upstream } = await fetchLiveMeta<LedgerAudit>(
    chain,
    `/operator/audit/${encodeURIComponent(business)}?days=${days}`,
    /* 12s, not the 5000ms default, for the reason its sibling
       `operator/businesses/route.ts` already gives: the press can be cold,
       and at 5s a refusal is the COMMON answer on a first visit. Measured
       here on 2026-10-10 — a cold press timed out and the page reported an
       outage, where the warm one answers 404 and the page can say the true
       thing instead. A budget too short to hear the answer turns a precise
       message back into a vague one. */
    12_000,
    cardHeader(req),
  );
  if (refusal) {
    return NextResponse.json(
      { live: false, data: null, fetchedAt: Date.now(), chain, refusal },
      { status: refusal.status, headers: passthroughRefusalHeaders(refusal.authenticate) },
    );
  }
  /* NO DATA IS A 503, NOT A 200. This route answered 200 with `data: null`,
     which is the lie `app/api/operator/businesses/route.ts` documents at
     length and fixed — and this file kept telling. `lib/useLive.ts`'s fetcher
     throws only on a non-ok status, so /spend's own "This statement could not
     be read." was unreachable code and a deep link rendered a blank page
     below the fold instead: no statement, no error, nothing. Measured against
     production on 2026-10-10 with the operator routes absent from the mainnet
     image. `upstream` distinguishes a host that is down from one that simply
     predates the route. */
  if (!data) {
    return NextResponse.json(
      { live: false, data: null, fetchedAt: Date.now(), chain, upstream, error: "the press did not answer" },
      { status: 503, headers: refusalHeaders() },
    );
  }

  return NextResponse.json(
    { live: true, data, fetchedAt: Date.now(), chain },
    // No cache. A findings list is the one thing on this site where a stale
    // "clean" is worse than no answer: it would report a book as checked that
    // nobody has checked since the last payment.
    { headers: { "Cache-Control": "no-store" } },
  );
}
