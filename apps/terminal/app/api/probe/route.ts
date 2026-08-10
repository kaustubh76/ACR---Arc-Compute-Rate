import { NextRequest, NextResponse } from "next/server";

import { apiBase } from "@/lib/api";
import { RUNNABLE } from "@/lib/endpoints";

/* POST /api/probe — call one free endpoint and report what came back.
 *
 * The endpoints table listed twenty-seven routes and let a reader run five of
 * them. The other twenty-two are FREE, so there was never a reason beyond the
 * absence of this route: a public GET needs no payment, no wallet and no
 * session, and a reader who can see the answer arrive stops having to take the
 * documentation's word for it.
 *
 * Deliberately NOT the console route. That one performs the two-act x402
 * exchange — bare request, read the 402, present payment, retry — which is the
 * right shape when money is involved and the wrong shape here. This does one
 * GET and reports status, elapsed and a truncated body.
 *
 * The allowlist is `RUNNABLE`, derived from lib/endpoints.ts rather than typed
 * again, and matched EXACTLY: no prefix matching, so no traversal, and a path
 * the register does not mark runnable cannot be reached through here even if
 * the press would serve it. Same discipline as app/api/console/route.ts.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Enough to prove the shape, not so much that a page renders a novel. */
const MAX_BODY = 1400;
/** The press is on a free tier and sleeps; a cold wake is the slow case this
 *  has to survive, and 5s (the console's budget) would fail every time. */
const TIMEOUT_MS = 12_000;

export async function POST(req: NextRequest) {
  let path = "";
  try {
    const body = await req.json();
    path = String(body.path ?? "");
  } catch {
    /* invalid JSON — rejected by the allowlist below */
  }
  if (!RUNNABLE.has(path)) {
    return NextResponse.json(
      { detail: `not runnable from here: ${path.slice(0, 80)}` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const started = Date.now();
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    return NextResponse.json(
      {
        path,
        status: res.status,
        ms: Date.now() - started,
        // Pretty-print when it parses, so the preview reads as a shape rather
        // than one long line. Non-JSON (a 404 page, an HTML error) passes
        // through as-is rather than being hidden.
        body: pretty(text).slice(0, MAX_BODY),
        truncated: text.length > MAX_BODY,
      },
      // Never cached: the whole product is that this happened just now.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // A timeout here is the ordinary free-tier cold start, not a fault, and
    // the copy says so rather than showing a reader a red error for a server
    // that is merely waking up.
    return NextResponse.json(
      {
        path,
        detail: "the press did not answer in time. It sleeps between visits, so press again",
        ms: Date.now() - started,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
