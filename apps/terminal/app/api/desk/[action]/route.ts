import { NextRequest, NextResponse } from "next/server";
import { apiBase } from "@/lib/api";
import { INDICES } from "@/lib/indices";
import { readTraderFills, readTraderPosition } from "@/lib/futuresOnchain";
import { readHeaders, readStatus } from "@/lib/readResult";

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
// `settle` is here because ACRFutures.settle is PERMISSIONLESS — the reader's
// own wallet pays the gas and rings the bell. Every refusal (not expired, no
// fresh print, already settled) is made server-side before a challenge is
// minted, so a PIN is never spent on a transaction that would revert.
const ACTIONS = new Set(["approve", "collateral", "trade", "withdraw", "settle"]);

/* 28s, just inside maxDuration. The read endpoints (`limits`, `withdrawable`)
   make sequential Arc RPC calls whose retry backoff alone can approach 15s on a
   throttled public node, so a 20s budget turned an answer that was on its way
   into "the press is unreachable" — the desk telling a reader it is down while
   it is up. There is no cheaper tier to fall back to here, so wait for it. */
async function forward(path: string, init: RequestInit): Promise<NextResponse> {
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(28_000),
    });
    const body = await res.json().catch(() => ({ detail: "bad upstream response" }));
    return NextResponse.json(body, { status: res.status });
  } catch (e) {
    // Distinguish slow from down. A cold desk read on a throttled Arc RPC can
    // exceed even the budget above, and the desk polls — so telling a reader
    // the press is UNREACHABLE when it is merely busy sends them away from a
    // page that would have worked on the next tick.
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return NextResponse.json(
      {
        detail: timedOut
          ? "the desk is reading the chain and it is slow right now — this retries on its own"
          : "the press is unreachable — the desk needs the live press",
      },
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
      // The session token, not an address: upstream derives the destination
      // from it, so the drip cannot be aimed at a wallet the caller doesn't own.
      const token = body.user_token;
      if (typeof token !== "string" || !TOKEN_RE.test(token)) {
        return NextResponse.json({ detail: "bad user_token" }, { status: 400 });
      }
      return forward("/desk/faucet", {
        method: "POST",
        body: JSON.stringify({ user_token: token }),
      });
    }
    case "limits": {
      const { address, index_id } = body as { address?: unknown; index_id?: unknown };
      if (
        typeof address !== "string" ||
        !ADDR_RE.test(address) ||
        typeof index_id !== "string" ||
        !(INDICES as readonly string[]).includes(index_id)
      ) {
        return NextResponse.json({ detail: "bad limits request" }, { status: 400 });
      }
      return forward("/desk/limits", {
        method: "POST",
        body: JSON.stringify({ address, index_id }),
      });
    }
    case "withdrawable": {
      const { address } = body as { address?: unknown };
      if (typeof address !== "string" || !ADDR_RE.test(address)) {
        return NextResponse.json({ detail: "bad withdrawable request" }, { status: 400 });
      }
      return forward("/desk/withdrawable", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
    }
    case "challenge": {
      const { user_token, wallet_id, action, index_id, qty, address, series_id } = body as {
        user_token?: unknown;
        wallet_id?: unknown;
        action?: unknown;
        index_id?: unknown;
        qty?: unknown;
        address?: unknown;
        series_id?: unknown;
      };
      if (
        typeof user_token !== "string" ||
        !TOKEN_RE.test(user_token) ||
        typeof wallet_id !== "string" ||
        !WALLET_ID_RE.test(wallet_id) ||
        typeof action !== "string" ||
        !ACTIONS.has(action) ||
        typeof index_id !== "string" ||
        !(INDICES as readonly string[]).includes(index_id) ||
        (address !== undefined && (typeof address !== "string" || !ADDR_RE.test(address))) ||
        (series_id !== undefined &&
          series_id !== null &&
          !(typeof series_id === "number" && Number.isInteger(series_id) && series_id >= 0))
      ) {
        return NextResponse.json({ detail: "bad challenge request" }, { status: 400 });
      }
      const q = typeof qty === "number" && Number.isFinite(qty) ? qty : 0;
      return forward("/desk/challenge", {
        method: "POST",
        body: JSON.stringify({
          user_token,
          wallet_id,
          action,
          index_id,
          qty: q,
          address: address ?? "",
          series_id: series_id ?? null,
        }),
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
      // A read that failed answers 503 with no-store, never 200 with a null.
      // Serving one throttled answer from the CDN for 10s handed every visitor
      // the same wrong state and stopped the retry ever reaching the origin.
      const r = await readTraderPosition(series, addr as `0x${string}`);
      return NextResponse.json(
        r.ok ? { position: r.value } : { detail: "could not read the chain just now", unread: true },
        { status: readStatus(r), headers: readHeaders(r) },
      );
    }
    /* A reader's own fills. The trade flow confirms by watching a position
       move, which yields no transaction — but `taker` is indexed on `Traded`,
       so their receipts are one topic-filtered query away. Validated exactly
       like `position`: same address shape, same series bounds. */
    case "fills": {
      const series = Number(q.get("series"));
      const addr = q.get("addr") ?? "";
      if (!Number.isInteger(series) || series < 0 || !ADDR_RE.test(addr)) {
        return NextResponse.json({ detail: "bad fills query" }, { status: 400 });
      }
      const r = await readTraderFills(series, addr as `0x${string}`);
      return NextResponse.json(
        r.ok ? { fills: r.value } : { detail: "could not read the chain just now", unread: true },
        { status: readStatus(r), headers: readHeaders(r) },
      );
    }
    default:
      return NextResponse.json({ detail: "unknown desk action" }, { status: 404 });
  }
}
