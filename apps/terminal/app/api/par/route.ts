import { NextResponse } from "next/server";
import { fetchLiveMeta } from "@/lib/api";
import { requestChain } from "@/lib/envelope";
import type { ChainKey } from "@/lib/chainChoice";
import { isUnit } from "@/lib/indices";
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
  const q = new URL(req.url).searchParams;

  const unit = (q.get("unit") ?? "").trim();
  // An ALLOWLIST, not a pattern. Three strings, from `lib/indices.ts`, which
  // the press derives from the same index roster — the discipline
  // `app/api/probe/route.ts` uses for its runnable paths, and for the same
  // reason: a set cannot be talked into matching something it does not hold.
  if (!isUnit(unit)) {
    return bad(chain, "unit must be one of the three priced units");
  }

  // REJECTED, NOT CLAMPED, and the difference matters here. `days` is clampable
  // because a window is a question and 1..90 are all sensible answers. A billed
  // amount is not: `Math.max(0.000001, 0)` would quietly turn a typo into a
  // passing bill and hand back a verdict about a number nobody entered. The
  // press refuses non-positive values; this says WHICH field was wrong, which
  // the press cannot because it sees them together.
  const billed = Number(q.get("billed_usdc"));
  if (!Number.isFinite(billed) || billed <= 0) {
    return bad(chain, "billed_usdc must be a number greater than zero");
  }
  const quantity = Number(q.get("quantity"));
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return bad(chain, "quantity must be a number greater than zero");
  }

  // Optional, and the same alternative `statement/route.ts` already carries in
  // its BUSINESS regex rather than a viem import for one test. Supplying it
  // changes the answer: the press benchmarks a vendor of ours against the fleet
  // and a stranger against the market, so this is a meaningful field and not a
  // label.
  const vendor = (q.get("vendor") ?? "").trim();
  if (vendor && !/^0x[0-9a-fA-F]{40}$/.test(vendor)) {
    return bad(chain, "vendor must be a 0x address, or left empty");
  }

  const path =
    `/par?unit=${encodeURIComponent(unit)}` +
    `&billed_usdc=${billed}&quantity=${quantity}` +
    (vendor ? `&vendor=${encodeURIComponent(vendor)}` : "");

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
