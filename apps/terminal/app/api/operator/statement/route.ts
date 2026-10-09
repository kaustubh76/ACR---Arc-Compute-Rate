import { NextResponse } from "next/server";
import { fetchLiveMeta } from "@/lib/api";
import { cardHeader, passthroughRefusalHeaders, requestChain } from "@/lib/envelope";
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
  const { data, refusal } = await fetchLiveMeta<Statement>(
    chain,
    `/operator/statement/${encodeURIComponent(business)}?days=${days}`,
    5000,
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

  return NextResponse.json(
    { live: Boolean(data), data: data ?? null, fetchedAt: Date.now(), chain },
    // No cache: the escalation queue is the part of this page somebody is
    // waiting on, and a cached one would show an approval that already happened.
    { headers: { "Cache-Control": "no-store" } },
  );
}
