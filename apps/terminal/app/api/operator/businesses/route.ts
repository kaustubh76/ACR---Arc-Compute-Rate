import { NextResponse } from "next/server";
import { fetchLiveMeta } from "@/lib/api";
import { chainHeaders, requestChain } from "@/lib/envelope";
import type { BusinessesPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

/* Proxy to FastAPI /operator/businesses — who the agent runs for.

   NO BUNDLE TIER, for the same reason /api/ops has none. Every other proxy
   falls back to the archived snapshot when the press is cold, because a
   month-old print is still a true print. A month-old BUSINESS LIST is not: it
   would assert that a business is onboarded, under its name, from a service
   that is not answering. These are the numbers a reviewer checks, so the page
   renders the absence instead.

   IT ANSWERED 200 WITH `data: null`, WHICH IS THE LIE THIS FILE NOW DOES NOT
   TELL. Measured against production on 2026-10-07, with the operator routes
   absent from the deployed image:

       GET /api/operator/businesses -> 200  {"live":false,"data":null,...}
       /spend rendered              -> "No businesses onboarded yet."

   The product has one business. The page said it had none, because a 200 is
   indistinguishable to a client from an empty answer, and `lib/useLive.ts`'s
   fetcher throws only on a non-ok STATUS — so /spend's own "we could not read
   this" copy was unreachable code and its `rows.length === 0` branch ran
   instead. Nothing was wrong with the copy; it could not be reached.

   503 rather than 502 or 200: `lib/readResult.ts` already picks exactly 200 for
   an answer and 503 for ask-again, "so a client's ordinary error path handles
   it", and this route is now the same shape as `operator/ledger/route.ts` (502
   upstream, 504 on throw, 422 on a bad slug) — the one proxy here that got it
   right first.

   `upstream` is stamped because `fetchLiveMeta` already computes it and
   `fetchLive` is literally that call with the reason discarded. A sleeping host
   and a host serving half the product are different facts and now read
   differently.

   12s, not the 5000ms default: the press is on a free tier that sleeps, and
   `app/api/probe/route.ts` budgets 12s for a cold wake for exactly this reason.
   Left at 5s, a refusal would be the COMMON case on a first visit — which is a
   different false statement, told to the same reviewer. */
export async function GET(req: Request) {
  const chain = requestChain(req);
  const { data, upstream } = await fetchLiveMeta<BusinessesPayload>(chain, "/operator/businesses",
    12_000,
  );
  if (!data) {
    return NextResponse.json(
      { live: false, data: null, fetchedAt: Date.now(), chain, upstream, error: "the press did not answer" },
      // A failed read must never be cached — the rule `readResult.ts` states,
      // and the reason /api/registry/keys stopped replaying a stale answer.
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { live: true, data, fetchedAt: Date.now(), chain, upstream },
    { headers: chainHeaders("public, s-maxage=30, stale-while-revalidate=120", chain) },
  );
}
