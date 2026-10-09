import { NextResponse } from "next/server";
import { fetchLiveMeta } from "@/lib/api";
import { cardHeader, passthroughRefusalHeaders, refusalHeaders, requestChain } from "@/lib/envelope";
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
  const chain = requestChain(req);
  const url = new URL(req.url);
  const business = (url.searchParams.get("business") ?? "").trim();
  if (!BUSINESS.test(business)) {
    return NextResponse.json(
      { live: false, data: null, fetchedAt: Date.now(), chain, error: "bad business" },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Clamped rather than passed through: a window nobody asked for is a slow
  // query somebody can ask for repeatedly.
  const raw = Number(url.searchParams.get("days") ?? 7);
  const days = Number.isFinite(raw) ? Math.min(90, Math.max(1, Math.trunc(raw))) : 7;

  /* The card is forwarded, not interpreted. `/spend` is public by design and
     stays public while `ACR_OPERATOR_READ_SCOPE` is unset upstream, so this hop
     has no opinion about whether a card is needed — it carries one if the
     browser sent one and lets the press answer. */
  const { data, refusal, upstream } = await fetchLiveMeta<Statement>(
    chain,
    `/operator/statement/${encodeURIComponent(business)}?days=${days}`,
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

  /* A REFUSAL KEEPS ITS OWN STATUS AND ITS OWN SENTENCE. Answering 200 with an
     empty envelope here would tell the reader "this business has no spend",
     which is both false and unactionable; the press already distinguishes "no
     card" from "a card for another business" from "a card nobody nominated",
     and those three sentences are the entire point of the gate. */
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
    // No cache: the escalation queue is the part of this page somebody is
    // waiting on, and a cached one would show an approval that already happened.
    { headers: { "Cache-Control": "no-store" } },
  );
}
