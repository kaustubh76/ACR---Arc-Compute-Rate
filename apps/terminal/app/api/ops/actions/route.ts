import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/* The operator console's proxy.

   Mirrors the validation discipline of app/api/desk/[action]/route.ts, for the
   same reason and with more at stake: the upstream path is a fixed literal,
   the body is REBUILT from validated fields rather than forwarded, and the
   action name is bounded before it leaves this host.

   The token is read from a header and passed through verbatim. It is never
   logged, never placed in a URL (where it would land in access logs and
   referrers), and never persisted here — the browser holds it in
   sessionStorage for the length of one tab. */

// Same resolution order as lib/api.ts, so the console can never end up
// pointing at a different press than the rest of the terminal.
const API = (
  process.env.ACR_API ??
  process.env.NEXT_PUBLIC_ACR_API ??
  "http://127.0.0.1:8000"
).replace(/\/$/, "");
const TOKEN_HEADER = "x-acr-ops-token";
// Bounded charset and length so a hostile header can never become a smuggled
// second header line. Shape only — the upstream decides whether it is right.
const TOKEN_RE = /^[A-Za-z0-9._-]{8,512}$/;
// Action names are `group/name`. The upstream registry is the real allowlist;
// this stops anything structurally unlike an action from being forwarded.
const ACTION_RE = /^[a-z][a-z-]{1,20}\/[a-z][a-z-]{1,20}$/;

function bad(status: number, message: string) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

async function forward(init: RequestInit, path: string): Promise<NextResponse> {
  try {
    const r = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(28_000) });
    const body = await r.json().catch(() => null);
    return NextResponse.json(body ?? { error: "the press sent no answer" }, {
      status: r.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Distinguish "slow" from "gone" the way the desk proxy does — an operator
    // deciding whether to retry needs to know which one they are looking at.
    return bad(504, "the press did not answer in time; it may be waking, or it may be down");
  }
}

/** The catalogue plus the audit trail. */
export async function GET(req: NextRequest) {
  const token = req.headers.get(TOKEN_HEADER);
  if (!token || !TOKEN_RE.test(token)) return bad(401, "operator key required");
  return forward(
    { method: "GET", headers: { "X-ACR-Ops-Token": token }, cache: "no-store" },
    "/ops/actions",
  );
}

/** Run one action. Dry-run is the default here too: the flag has to be an
 *  explicit `false` to execute, so a malformed body can never spend money. */
export async function POST(req: NextRequest) {
  const token = req.headers.get(TOKEN_HEADER);
  if (!token || !TOKEN_RE.test(token)) return bad(401, "operator key required");

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return bad(400, "expected a JSON body");
  const { action, params, dry_run } = body as {
    action?: unknown;
    params?: unknown;
    dry_run?: unknown;
  };
  if (typeof action !== "string" || !ACTION_RE.test(action)) return bad(400, "bad action");
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params)))
    return bad(400, "params must be an object");
  if (dry_run !== undefined && typeof dry_run !== "boolean") return bad(400, "dry_run must be a boolean");

  return forward(
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ACR-Ops-Token": token },
      // Rebuilt, not forwarded. Only these three fields can ever reach the press.
      body: JSON.stringify({
        action,
        params: (params as Record<string, unknown>) ?? {},
        dry_run: dry_run === false ? false : true,
      }),
      cache: "no-store",
    },
    "/ops/actions",
  );
}
