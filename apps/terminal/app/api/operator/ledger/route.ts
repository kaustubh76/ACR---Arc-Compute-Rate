import { NextResponse } from "next/server";
import { apiBase } from "@/lib/api";

export const dynamic = "force-dynamic";

/* Proxy to FastAPI /operator/ledger/{business}.

   NOT JSON. The press answers this one as text/plain beancount, so it cannot go
   through `fetchLive` — that parses, and a parsed ledger is no longer a ledger.
   `app/api/console/route.ts` reads an upstream body the same way, with the
   ladder's own base rather than the configured host.

   This route exists because the export did not have one. The beancount file was
   built, tested, documented in the README and reachable only by typing the
   press URL: /traction linked to `/operator/ledger/{slug}`, which is the
   PRESS's path space, so on the terminal origin it resolved here and 404ed. A
   double-entry ledger whose whole claim is "you can check this" was the one
   artifact a reader could not open.

   THE PARAM BECOMES A PATH SEGMENT upstream, so it is validated rather than
   interpolated and hoped over — the same rule, and the same shape, as
   `app/api/operator/statement/route.ts`. */
const BUSINESS = /^(0x[0-9a-fA-F]{40}|[a-z0-9][a-z0-9-]{0,40})$/;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const business = (url.searchParams.get("business") ?? "").trim();
  if (!BUSINESS.test(business)) {
    return NextResponse.json(
      { error: "bad business" },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Clamped to the press's own window (app.py clamps to 1..365 too), so a
  // request for ten years cannot become a slow query somebody repeats.
  const raw = Number(url.searchParams.get("days") ?? 90);
  const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.trunc(raw))) : 90;

  let text: string;
  try {
    // Longer than the 5s `fetchLive` default on purpose: this is a download
    // somebody clicked, not a poll behind a page, and a year of decisions is a
    // longer walk than a statement. Still bounded — an unbounded fetch in a
    // route handler is a held connection, not a patient one.
    const res = await fetch(
      `${apiBase()}/operator/ledger/${encodeURIComponent(business)}?days=${days}`,
      { cache: "no-store", signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      return NextResponse.json(
        { error: `the press answered ${res.status}` },
        { status: res.status === 404 ? 404 : 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    text = await res.text();
  } catch {
    return NextResponse.json(
      { error: "the press did not answer" },
      { status: 504, headers: { "Cache-Control": "no-store" } },
    );
  }

  return new NextResponse(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // An attachment, named for the business: beancount is a file format with
      // tools that read it, and a tab of plain text is not something you can
      // run `bean-check` over.
      "Content-Disposition": `attachment; filename="${business}.beancount"`,
      // No cache: a ledger that balanced an hour ago is not evidence that the
      // one you are looking at balances now.
      "Cache-Control": "no-store",
    },
  });
}
