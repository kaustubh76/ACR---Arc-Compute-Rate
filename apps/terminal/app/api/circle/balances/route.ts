import { NextResponse } from "next/server";
import { apiBase } from "@/lib/api";
import { requestChain } from "@/lib/envelope";
import { CHAIN } from "@/lib/chain";
import { buyerConfigured, getGatewayClient } from "@/lib/gatewayBuyer";
import type { BalancesData, Envelope, WalletBalance, X402Info } from "@/lib/types";

// Reads balances through the Circle SDK (correct USDC decimals) — Node only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — live USDC standings for the seller (pay_to) and buyer wallets, plus the
 *  buyer's Gateway deposit. Powered by the same funded key as the buyer route,
 *  so the panel only lights up when a buyer is configured. */
export async function GET(req: Request) {
  const chain = requestChain(req);
  const off = (note: string): NextResponse => {
    const env: Envelope<BalancesData> = {
      live: false,
      data: { buyer_ready: false, wallets: [], note },
      fetchedAt: Date.now(), chain,
    };
    return NextResponse.json(env);
  };

  if (!buyerConfigured()) {
    return off("connect a funded buyer (ACR_BUYER_PRIVATE_KEY) to read live Gateway balances");
  }

  // The seller's receiving wallet, from the live gate descriptor.
  let payTo: string | null = null;
  let gatewayChain: string = CHAIN.gatewayChain;
  let privateMainnet = false;
  try {
    const res = await fetch(`${apiBase(chain)}/x402/info`, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      const j = (await res.json()) as X402Info;
      payTo = j.pay_to ?? null;
      gatewayChain = j.gateway_chain ?? gatewayChain;
      privateMainnet = Boolean(j.private_mainnet);
    }
  } catch {
    /* seller offline — still report the buyer */
  }

  try {
    const client = await getGatewayClient({ gatewayChain, privateMainnet });
    const wallets: WalletBalance[] = [];

    const bal = await client.getBalances();
    wallets.push({
      role: "buyer",
      address: client.address,
      usdc: bal.wallet.formatted,
      gateway: {
        available: bal.gateway.formattedAvailable,
        total: bal.gateway.formattedTotal,
        withdrawing: bal.gateway.formattedWithdrawing,
      },
    });

    if (payTo && /^0x[0-9a-fA-F]{40}$/.test(payTo)) {
      try {
        const seller = await client.getUsdcBalance(payTo as `0x${string}`);
        wallets.push({ role: "seller", address: payTo, usdc: seller.formatted, gateway: null });
      } catch {
        wallets.push({ role: "seller", address: payTo, usdc: null, gateway: null });
      }
    }

    const env: Envelope<BalancesData> = {
      live: true,
      data: { buyer_ready: true, wallets },
      fetchedAt: Date.now(), chain,
    };
    return NextResponse.json(env);
  } catch (e) {
    return off(`balance read failed: ${String((e as Error).message).slice(0, 160)}`);
  }
}
