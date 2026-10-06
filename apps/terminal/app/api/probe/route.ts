import { NextRequest, NextResponse } from "next/server";

import { CARD_HEADER } from "@/lib/agentcard";
import { baseState, sellerFetch } from "@/lib/api";
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
 *
 * ONE OPTIONAL FIELD LETS A VISITOR FEEL THE AGENT GATE rather than read about it:
 *
 *   agent_card   a card the visitor signed IN THEIR OWN TAB with a throwaway key.
 *                Forwarded upstream as AGENT-CARD, nothing else. The key never
 *                reaches this server; we only ever see the header.
 *
 * The allowlist is untouched by it. A card changes what the press SAYS about a
 * call, never which calls can be made.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Enough to prove the shape, not so much that a page renders a novel. */
const MAX_BODY = 1400;
/** The press is on a free tier and sleeps; a cold wake is the slow case this
 *  has to survive, and 5s (the console's budget) would fail every time. */
const TIMEOUT_MS = 12_000;

/** A card is ~600 bytes of base64. Anything much larger is not a card. */
const MAX_CARD = 2048;

export async function POST(req: NextRequest) {
  let path = "";
  let agentCard: string | undefined;
  try {
    const body = await req.json();
    path = String(body.path ?? "");
    if (typeof body.agent_card === "string" && body.agent_card.length <= MAX_CARD) {
      agentCard = body.agent_card;
    }
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
    const { res } = await sellerFetch(path, {
      cache: "no-store",
      headers: { accept: "application/json", ...(agentCard ? { [CARD_HEADER]: agentCard } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    return NextResponse.json(
      {
        path,
        status: res.status,
        ms: Date.now() - started,
        // Which host served this probe, so "503" is attributable to a wrong
        // ACR_API rather than to the press being down.
        seller: baseState(),
        // The tier, parsed here, so the page does not have to read it back out of a
        // truncated preview string. Only /agent/whoami answers with one; elsewhere
        // it is simply absent. `carded` is whether a card was SENT, so a 401 on a
        // carded run can be named as a refused card rather than a failed route.
        ...whoamiOf(text),
        carded: Boolean(agentCard),
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

/** The whoami fields the page renders as prose rather than as JSON: `tier` picks
 *  the badge, `ident_kind` says what the budget is keyed on. Parsed here so the
 *  page does not have to read them back out of a truncated preview string. */
function whoamiOf(text: string): { tier?: string; ident_kind?: string } {
  try {
    const j = JSON.parse(text) as { tier?: unknown; ident_kind?: unknown };
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return { tier: str(j.tier), ident_kind: str(j.ident_kind) };
  } catch {
    return {};
  }
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
