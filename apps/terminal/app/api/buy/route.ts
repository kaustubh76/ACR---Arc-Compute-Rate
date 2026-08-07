import { NextRequest, NextResponse } from "next/server";
import { apiBase } from "@/lib/api";
import { buyerConfigured, getGatewayClient, SPEND_CAP_USDC } from "@/lib/gatewayBuyer";
import { chooseTargets, clampCount, withinCap } from "@/lib/buyPlan";
import { PRICE_FALLBACK_USDC } from "@/lib/indices";
import type { LiveBuyResponse, LiveBuyResult, X402Info } from "@/lib/types";

// The Circle SDK is a Node package (viem, EIP-3009 signing) — never edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — is a funded buyer available, and is the seller on the real Circle gate? */
export async function GET() {
  let gate: "dev" | "circle" | null = null;
  try {
    const res = await fetch(`${apiBase()}/x402/info`, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (res.ok) gate = ((await res.json()) as X402Info).facilitator;
  } catch {
    /* seller offline → gate stays null */
  }
  const env: LiveBuyResponse = {
    live: gate !== null,
    buyer_ready: buyerConfigured() && gate === "circle",
    gate,
    payer: null,
    results: [],
    spent_usdc: 0,
    cap_usdc: SPEND_CAP_USDC,
    fetchedAt: Date.now(),
  };
  return NextResponse.json(env);
}

/** POST — originate up to `count` REAL Circle Gateway settlements against the
 *  seller's gated endpoints. Synchronous (serverless-safe): runs the payments
 *  and returns the full trace; the client renders/toasts each result. */
export async function POST(req: NextRequest) {
  if (!buyerConfigured()) {
    return NextResponse.json(
      { detail: "no funded buyer: set ACR_BUYER_PRIVATE_KEY (a funded EOA with an open Gateway deposit)" },
      { status: 400 },
    );
  }

  let count = 3;
  let paths: string[] | null = null;
  try {
    const body = await req.json();
    count = clampCount(body.count);
    if (Array.isArray(body.paths)) paths = body.paths.map(String);
  } catch {
    /* defaults */
  }

  const base = apiBase();

  // The real buyer only makes sense against the real Circle gate — the dev
  // mock gate emits a 402 the Gateway SDK won't recognize as a batching option.
  let gate: "dev" | "circle" | null = null;
  let price = PRICE_FALLBACK_USDC;
  try {
    const info = await fetch(`${base}/x402/info`, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (info.ok) {
      const j = (await info.json()) as X402Info;
      gate = j.facilitator;
      if (Number.isFinite(j.price_usdc) && j.price_usdc > 0) price = j.price_usdc;
    }
  } catch {
    /* handled below */
  }
  if (gate !== "circle") {
    return NextResponse.json(
      { detail: `real settlement needs the Circle gate (seller gate: ${gate ?? "offline"}). Use the dev buyer otherwise.` },
      { status: 409 },
    );
  }

  // Caller paths only when non-empty AND all-allowlisted; else the safe
  // rotation. Never empty (an empty list would pay a `/undefined` URL).
  const targets = chooseTargets(paths, count);

  let client;
  try {
    client = await getGatewayClient();
  } catch (e) {
    return NextResponse.json({ detail: String((e as Error).message) }, { status: 400 });
  }

  const results: LiveBuyResult[] = [];
  let spent = 0;
  for (let i = 0; i < count; i++) {
    const path = targets[i % targets.length];
    // Cumulative spend cap — refuse BEFORE the payment that would breach it.
    if (!withinCap(spent, price, SPEND_CAP_USDC)) {
      results.push({ path, status: 0, price_usdc: 0, tx_ref: "", network: "", error: `spend cap ${SPEND_CAP_USDC} USDC reached` });
      break;
    }
    try {
      const r = await client.pay(`${base}${path}`);
      const paid = Number(r.formattedAmount);
      spent += Number.isFinite(paid) ? paid : 0;
      results.push({
        path,
        status: r.status,
        price_usdc: Number.isFinite(paid) ? paid : price,
        tx_ref: r.transaction,
        network: "eip155:5042002",
      });
    } catch (e) {
      // Surface Circle's real verify/settle reason (e.g. insufficient_balance).
      results.push({ path, status: 402, price_usdc: 0, tx_ref: "", network: "", error: String((e as Error).message).slice(0, 300) });
      break;
    }
  }

  const resp: LiveBuyResponse = {
    live: true,
    buyer_ready: true,
    gate: "circle",
    payer: client.address,
    results,
    spent_usdc: Number(spent.toFixed(6)),
    cap_usdc: SPEND_CAP_USDC,
    fetchedAt: Date.now(),
  };
  return NextResponse.json(resp);
}
