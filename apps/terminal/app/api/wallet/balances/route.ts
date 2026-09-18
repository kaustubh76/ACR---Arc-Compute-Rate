import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, erc20Abi, formatUnits, http, isAddress } from "viem";
import { bundleSection } from "@/lib/api";
import { CHAIN, chainFacts } from "@/lib/chain";
import { GATEWAY_WALLET_ABI } from "@/lib/walletPayer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?address=0x… — what a visitor's wallet holds, read from the chain by THIS
 *  server. Two numbers, both in the 6-decimal USDC view: the wallet's USDC
 *  balance, and the Gateway balance it can pay x402 from. Server-side on purpose:
 *  the read goes through our RPC, which on Arc mainnet is credentialed and must
 *  not be handed to a browser. Read-only; the address is the visitor's claim. */
export async function GET(req: NextRequest) {
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  if (!isAddress(address)) return NextResponse.json({ detail: "address is not an EVM address" }, { status: 400 });

  const f = chainFacts(bundleSection("chain") ?? null);
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
    return NextResponse.json({
      address,
      network: f.caip2,
      usdc_wallet: Number(formatUnits(wallet, 6)),
      usdc_gateway: Number(formatUnits(gatewayAvail, 6)),
      gateway_wallet: gateway || null,
      fetchedAt: Date.now(),
    });
  } catch (e) {
    return NextResponse.json({ detail: `chain read failed: ${(e as Error).message.slice(0, 120)}` }, { status: 502 });
  }
}
