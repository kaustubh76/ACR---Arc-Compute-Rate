import { NextRequest, NextResponse } from "next/server";
import { apiBase } from "@/lib/api";
import type { BuyerRunStatus, Envelope } from "@/lib/types";

export const dynamic = "force-dynamic";
// POST rides out a free-tier wake instead of hard-failing at 5s.
export const maxDuration = 15;

/** GET — the floor buyer's run status (mirrors /api/attack/status). */
export async function GET() {
  try {
    const res = await fetch(`${apiBase()}/demo/buyer/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const env: Envelope<BuyerRunStatus | null> = {
        live: true,
        data: (await res.json()) as BuyerRunStatus,
        fetchedAt: Date.now(),
      };
      return NextResponse.json(env);
    }
  } catch {
    /* offline */
  }
  const env: Envelope<BuyerRunStatus | null> = { live: false, data: null, fetchedAt: Date.now() };
  return NextResponse.json(env);
}

/** POST — release the buyer. Body forwarded verbatim ({count, delay_ms}). */
export async function POST(req: NextRequest) {
  let body = "{}";
  try {
    body = JSON.stringify(await req.json());
  } catch {
    /* empty body → backend defaults */
  }
  try {
    const res = await fetch(`${apiBase()}/demo/buyer/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json(
      { detail: "the press is still waking; give it a minute and release again" },
      { status: 503 },
    );
  }
}
