import { NextResponse } from "next/server";

import { apiBase } from "@/lib/api";
import { envelope, refusalHeaders, requestChain } from "@/lib/envelope";
import type { FloatQueue } from "@/lib/float";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* The approval queue, proxied.

   ONE FIXED UPSTREAM PATH. No dynamic segment, and no caller string reaches
   the URL, so there is nothing here to aim at another host the way a payer
   parameter once pointed at the press's own /health and served it as a TCA.

   NO SHARED CACHE DIRECTIVE. A queue of payments waiting on one particular
   human is not something to hand a second visitor out of a CDN, and the codes
   in it expire in minutes. `no-store` on every answer.

   The press answers a bare object, so it is wrapped before it leaves: the
   client fetcher treats a missing chain stamp as a mismatch rather than as a
   default, which is the right failure and a terrible silent one. */

const TIMEOUT_MS = 9_000;

const STOOD_DOWN: FloatQueue = {
  status: "pending",
  reason: "the press did not answer, so nothing can be said about what is parked",
  checkpoints: [],
};

export async function GET(req: Request) {
  const chain = requestChain(req);
  try {
    const res = await fetch(`${apiBase(chain)}/float/checkpoints`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return NextResponse.json(envelope(STOOD_DOWN, { live: false, chain }), {
        headers: refusalHeaders(),
      });
    }
    const body = (await res.json()) as FloatQueue;
    const data: FloatQueue = {
      status: body?.status === "ok" ? "ok" : "pending",
      ...(body?.reason ? { reason: String(body.reason) } : {}),
      checkpoints: Array.isArray(body?.checkpoints) ? body.checkpoints : [],
    };
    return NextResponse.json(envelope(data, { live: true, chain }), {
      headers: refusalHeaders(),
    });
  } catch {
    /* Slow and down look the same from here, and both mean one thing to a
       reader: we cannot say what is waiting on them. Never an empty list. */
    return NextResponse.json(envelope(STOOD_DOWN, { live: false, chain }), {
      headers: refusalHeaders(),
    });
  }
}
