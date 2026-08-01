import { NextRequest, NextResponse } from "next/server";
import { apiBase } from "@/lib/api";
import { INDICES } from "@/lib/indices";
import { readTraderPosition } from "@/lib/futuresOnchain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/* The Public Desk proxy. Every upstream path is a fixed string chosen by the
   `action` segment against an exact allowlist, and every body is REBUILT from
   validated fields — no user string reaches the upstream URL (the /api/console
   SSRF discipline). `position` never leaves this host: it is a direct paced
   viem read of ACRFutures. */

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const USER_ID_RE = /^[A-Za-z0-9._-]{5,64}$/;
// Circle userTokens are JWTs; bound charset+length, never interpolated in URLs.
const TOKEN_RE = /^[A-Za-z0-9._-]{16,4096}$/;
const WALLET_ID_RE = /^[a-f0-9-]{8,64}$/i;
const ACTIONS = new Set(["approve", "collateral", "trade"]);

async function forward(path: string, init: RequestInit): Promise<NextResponse> {
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({ detail: "bad upstream response" }));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json(
      { detail: "the press is unreachable — the desk needs the live press" },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest, { params }: { params: { action: string } }) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ detail: "bad body" }, { status: 400 });

  switch (params.action) {
    case "session": {
      const userId = body.user_id;
      if (typeof userId !== "string" || !USER_ID_RE.test(userId)) {
        return NextResponse.json({ detail: "bad user_id" }, { status: 400 });
      }
      return forward("/desk/session", {
        method: "POST",
        body: JSON.stringify({ user_id: userId }),
      });
    }
    case "wallet": {
      const token = body.user_token;
      if (typeof token !== "string" || !TOKEN_RE.test(token)) {
        return NextResponse.json({ detail: "bad user_token" }, { status: 400 });
      }
      return forward("/desk/wallet", {
        method: "POST",
        body: JSON.stringify({ user_token: token }),
      });
    }
    case "faucet": {
      const address = body.address;
      if (typeof address !== "string" || !ADDR_RE.test(address)) {
        return NextResponse.json({ detail: "bad address" }, { status: 400 });
      }
      return forward("/desk/faucet", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
    }
    case "challenge": {
      const { user_token, wallet_id, action, index_id, qty } = body as {
        user_token?: unknown;
        wallet_id?: unknown;
        action?: unknown;
        index_id?: unknown;
        qty?: unknown;
      };
      if (
        typeof user_token !== "string" ||
        !TOKEN_RE.test(user_token) ||
        typeof wallet_id !== "string" ||
        !WALLET_ID_RE.test(wallet_id) ||
        typeof action !== "string" ||
        !ACTIONS.has(action) ||
        typeof index_id !== "string" ||
        !(INDICES as readonly string[]).includes(index_id)
      ) {
        return NextResponse.json({ detail: "bad challenge request" }, { status: 400 });
      }
      const q = typeof qty === "number" && Number.isFinite(qty) ? qty : 0;
      return forward("/desk/challenge", {
        method: "POST",
        body: JSON.stringify({ user_token, wallet_id, action, index_id, qty: q }),
      });
    }
    default:
      return NextResponse.json({ detail: "unknown desk action" }, { status: 404 });
  }
}

export async function GET(req: NextRequest, { params }: { params: { action: string } }) {
  const q = req.nextUrl.searchParams;
  switch (params.action) {
    case "position": {
      const series = Number(q.get("series"));
      const addr = q.get("addr") ?? "";
      if (!Number.isInteger(series) || series < 0 || !ADDR_RE.test(addr)) {
        return NextResponse.json({ detail: "bad position query" }, { status: 400 });
      }
      const position = await readTraderPosition(series, addr as `0x${string}`);
      return NextResponse.json(
        { position },
        { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } },
      );
    }
    default:
      return NextResponse.json({ detail: "unknown desk action" }, { status: 404 });
  }
}
