import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, erc20Abi, formatUnits, http, isAddress } from "viem";
import { bundleSection } from "@/lib/api";
import { requestChain } from "@/lib/envelope";
import { emptyChainFacts } from "@/lib/chainChoice";
import { CHAIN, chainFacts } from "@/lib/chain";
import { GATEWAY_WALLET_ABI, fundingStep } from "@/lib/walletPayer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?address=0x…&price=0.001 — what a visitor's wallet holds, read from the
 *  chain by THIS server, and the one thing to do next. Two numbers, both in the
 *  6-decimal USDC view: the wallet's USDC balance, and the Gateway balance it
 *  can pay x402 from; `next` is bridge | deposit | ready against `price`.
 *  Server-side on purpose: the read goes through our RPC, which may be a keyed
 *  provider URL that must not reach a browser. Read-only; the address is the
 *  visitor's claim. */
export async function GET(req: NextRequest) {
  const chain = requestChain(req);
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  if (!isAddress(address)) return NextResponse.json({ detail: "address is not an EVM address" }, { status: 400 });
  const price = Math.max(0, Number(req.nextUrl.searchParams.get("price") ?? 0) || 0);

  /* `emptyChainFacts(chain)`, NOT `null`. The bundle is mainnet-only
     (`chainChoice.ts` sets `bundle: false` off the default), so on the other
     chain `bundleSection` is undefined — and `chainFacts(null)` falls back to
     the MAINNET profile field by field: mainnet USDC, mainnet Gateway, mainnet
     RPC, and the answer labelled `eip155:5042`. A visitor on the practice
     network was being shown their real-money balance and a real-money funding
     plan. `emptyChainFacts` is the chain-correct cushion and is already pinned
     by lib/chainChoice.test.ts; this route simply was not using it.

     Note the gates could not see this: `mainnetOnly.test.ts` scans for testnet
     LITERALS and the bug is the absence of a value, and `chainWiring.test.ts`
     passes because the route does resolve the chain and does stamp it. Wiring
     the chain through is not the same as using it. */
  const f = chainFacts(bundleSection(chain, "chain") ?? emptyChainFacts(chain));
  /* The env override stays FIRST because it is a local-development escape
     hatch, and it is deliberately chain-blind: one variable cannot be right
     for two chains. Unset in production, where `f.rpc` is the chain's own. */
  const rpc = process.env.ACR_ARC_RPC_URL ?? f.rpc ?? CHAIN.rpc;
  if (!rpc) return NextResponse.json({ detail: "no RPC configured on this server" }, { status: 503 });
  const client = createPublicClient({ transport: http(rpc, { timeout: 8_000 }) });
  const usdc = f.usdc as `0x${string}`;
  const gateway = f.gatewayWallet as `0x${string}`;
  try {
    const [wallet, gatewayAvail] = await Promise.all([
      client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      gateway
        ? client.readContract({ address: gateway, abi: GATEWAY_WALLET_ABI, functionName: "availableBalance", args: [usdc, address] })
        : Promise.resolve(0n),
    ]);
    const usdcWallet = Number(formatUnits(wallet, 6));
    const usdcGateway = Number(formatUnits(gatewayAvail, 6));
    return NextResponse.json({
      address,
      network: f.caip2,
      usdc_wallet: usdcWallet,
      usdc_gateway: usdcGateway,
      gateway_wallet: gateway || null,
      next: fundingStep(usdcWallet, usdcGateway, price),
      fetchedAt: Date.now(), chain,
    });
  } catch (e) {
    return NextResponse.json({ detail: `chain read failed: ${(e as Error).message.slice(0, 120)}` }, { status: 502 });
  }
}
