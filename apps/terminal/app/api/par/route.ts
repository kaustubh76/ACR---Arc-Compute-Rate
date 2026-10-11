import { NextResponse } from "next/server";
import { fetchLiveMeta } from "@/lib/api";
import { requestChain } from "@/lib/envelope";
import type { ChainKey } from "@/lib/chainChoice";
import { parPath, parseParQuery } from "@/lib/parQuery";
import { freshHeaders } from "@/lib/readResult";
import type { ParCheck } from "@/lib/types";

export const dynamic = "force-dynamic";

/* Proxy to FastAPI GET /par — one bill, priced against published prices.

   Shaped on `app/api/operator/statement/route.ts`: same envelope, same
   422-on-bad-input, same `dynamic` export, no `runtime` (nothing here needs a
   node-only library).

   EVERY PARAMETER IS VALIDATED HERE, and that is not belt-and-braces. The press
   has TWO different 422 bodies: its own refusals put a sentence in `detail`,
   while a missing or unparseable number never reaches them and gets FastAPI's
   validator instead, whose `detail` is an array of objects. A page that has to
   render both shapes renders neither well, so nothing malformed leaves this
   file and `detail` is always a sentence by the time a reader sees it.

   `freshHeaders()` rather than `readHeaders()`: a price check is a button
   somebody pressed. That function was written after production replayed one
   `/api/registry/keys` answer for 40s under `x-vercel-cache: STALE` — "a press
   is a deliberate act, not a poll" — and a cached verdict on a bill the visitor
   just edited is the same bug with money in it. */

export async function GET(req: Request) {
  const chain = requestChain(req);

  // The validation moved to `lib/parQuery.ts`, unchanged, because the preview
  // image a shared `/check?…` link unfurls with reads the same four fields:
  // an allowlisted unit, amounts REJECTED rather than clamped so a typo never
  // becomes a passing bill, and an optional vendor that changes the answer.
  // Each refusal still names the field, which the press cannot do because it
  // sees them together.
  const q = new URL(req.url).searchParams;
  const parsed = parseParQuery((k) => q.get(k));
  if (!parsed.ok) return bad(chain, parsed.error);
  const path = parPath(parsed.q);

  // 12s, matching the cold-wake budget in `app/api/probe/route.ts`: this is the
  // first thing many visitors will press, and the press sleeps on a free tier.
  const { data, upstream } = await fetchLiveMeta<ParCheck>(chain, path, 12_000);
  if (!data) {
    return NextResponse.json(
      { live: false, data: null, fetchedAt: Date.now(), chain, upstream, error: "the press did not answer" },
      { status: 503, headers: freshHeaders() },
    );
  }
  return NextResponse.json(
    { live: true, data, fetchedAt: Date.now(), chain, upstream },
    { headers: freshHeaders() },
  );
}

/** One refusal shape, so the page has one error path to render. */
function bad(chain: ChainKey, error: string) {
  return NextResponse.json(
    { live: false, data: null, fetchedAt: Date.now(), chain, error },
    { status: 422, headers: freshHeaders() },
  );
}
