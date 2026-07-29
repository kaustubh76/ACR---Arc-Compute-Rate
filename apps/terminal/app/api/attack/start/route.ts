import { NextRequest, NextResponse } from "next/server";
import { apiBase } from "@/lib/api";

export const dynamic = "force-dynamic";

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
      signal: AbortSignal.timeout(5000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json(
      { detail: "the lab requires the live index API (make api)" },
      { status: 503 },
    );
  }
}
