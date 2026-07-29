import { NextRequest, NextResponse } from "next/server";
import { apiBase, bundleSection } from "@/lib/api";
import { INDICES, PRICE_FALLBACK_USDC } from "@/lib/indices";
import type { ConsoleResult, Envelope, X402Info } from "@/lib/types";

export const dynamic = "force-dynamic";

// Exact-match allowlist — user input is never interpolated into the upstream URL
// beyond a string that already appears here (prevents SSRF / path traversal).
const ALLOWED = new Set<string>([
  "/prints",
  ...INDICES.flatMap((i) => [
    `/prints/${i}`,
    `/curve/${i}`,
    `/vol/${i}`,
    `/seller-scores/${i}`,
  ]),
]);
// DevFacilitator splits the mock header on " " then ":", so the payer must
// contain neither. Also bounds length.
const PAYER_RE = /^0x[A-Za-z0-9-]{1,64}$/;
// Fallback when /x402/info is unreachable; the live advertised price is read
// through a 60s module memo so the paid-query hot path doesn't pay a serial
// upstream hop per request (ACR_X402_PRICE_USDC changes land within a minute).
const PRICE = String(PRICE_FALLBACK_USDC);
let priceMemo: { value: string; at: number } | null = null;
const PRICE_MEMO_MS = 60_000;

async function advertisedPrice(base: string): Promise<string> {
  if (priceMemo && Date.now() - priceMemo.at < PRICE_MEMO_MS) return priceMemo.value;
  let price = PRICE;
  try {
    const info = await fetch(`${base}/x402/info`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (info.ok) {
      const p = ((await info.json()) as X402Info | null)?.price_usdc;
      if (typeof p === "number" && Number.isFinite(p) && p > 0) price = String(p);
    }
  } catch {
    /* fall back to the default price */
  }
  priceMemo = { value: price, at: Date.now() };
  return price;
}

const CHALLENGE_HEADERS = [
  "www-authenticate",
  "x-402-price",
  "x-402-asset",
  "x-402-network",
  "x-402-pay-to",
  "payment-required",
];

function pickHeaders(res: Response, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = res.headers.get(n);
    if (v != null) out[n] = v;
  }
  return out;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

/** GET — proxy /x402/info so the client can label the gate + gate the demo agent. */
export async function GET() {
  try {
    const res = await fetch(`${apiBase()}/x402/info`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const env: Envelope<X402Info | null> = {
        live: true,
        data: (await res.json()) as X402Info,
        fetchedAt: Date.now(),
      };
      return NextResponse.json(env, {
        headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300" },
      });
    }
  } catch {
    /* offline */
  }
  const env: Envelope<X402Info | null> = {
    live: false,
    data: bundleSection("x402") ?? null,
    fetchedAt: Date.now(),
  };
  return NextResponse.json(env, {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300" },
  });
}

/** POST — the two-act x402 exchange: 402 challenge, then pay and retry. */
export async function POST(req: NextRequest) {
  let path = "";
  let payer = "";
  try {
    const body = await req.json();
    path = String(body.path ?? "");
    payer = String(body.payer ?? "");
  } catch {
    /* invalid JSON → validated below */
  }
  if (!ALLOWED.has(path)) {
    return NextResponse.json({ detail: `path not permitted: ${path}` }, { status: 400 });
  }
  if (!PAYER_RE.test(payer)) {
    return NextResponse.json({ detail: "payer must match 0x[A-Za-z0-9-]{1,64}" }, { status: 400 });
  }

  const base = apiBase();
  try {
    // Act I — bare request, expect a 402 challenge.
    const r1 = await fetch(`${base}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const act1: ConsoleResult["act1"] = {
      status: r1.status,
      headers: pickHeaders(r1, CHALLENGE_HEADERS),
    };
    // The b64 header now carries the full {x402Version, accepts:[…]} envelope;
    // surface the PaymentRequirements object itself (accepts[0]) for display.
    const pr = act1.headers["payment-required"];
    if (pr) {
      try {
        const envelope = JSON.parse(Buffer.from(pr, "base64").toString("utf8"));
        act1.paymentRequirements = envelope?.accepts?.[0] ?? envelope;
      } catch {
        /* leave raw */
      }
    }

    // Act II — present payment and retry, at the gate's advertised price.
    const price = await advertisedPrice(base);
    const r2 = await fetch(`${base}${path}`, {
      cache: "no-store",
      headers: { "PAYMENT-SIGNATURE": `x402 ${payer}:${price}` },
      signal: AbortSignal.timeout(5000),
    });
    const act2: ConsoleResult["act2"] = {
      status: r2.status,
      body: await readBody(r2),
      paymentResponse: r2.headers.get("payment-response") ?? undefined,
    };

    const result: ConsoleResult = { live: true, act1, act2, paid: r2.status === 200 };
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { live: false, detail: "the console requires the live index API (make api)" },
      { status: 503 },
    );
  }
}
