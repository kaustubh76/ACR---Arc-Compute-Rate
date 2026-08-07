import { NextRequest, NextResponse } from "next/server";
import { apiBase } from "@/lib/api";

export const dynamic = "force-dynamic";
// The free-tier press can be mid-wake when a visitor commences an attack —
// give the upstream long enough to boot instead of hard-failing at 5s.
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let body = "{}";
  try {
    body = JSON.stringify(await req.json());
  } catch {
    /* empty body → defaults */
  }
  try {
    const res = await fetch(`${apiBase()}/demo/attack/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json(
      { detail: "the press is still waking; give it a minute and commence again" },
      { status: 503 },
    );
  }
}
