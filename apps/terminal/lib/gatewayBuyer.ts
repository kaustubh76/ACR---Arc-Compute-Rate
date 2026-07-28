/* Real Circle Gateway buyer — server-only.
 *
 * The seller (index_api) can only VERIFY/SETTLE incoming x402 payments; it
 * cannot originate one. This module makes the Terminal itself the buyer: it
 * lazy-loads Circle's official `@circle-fin/x402-batching` GatewayClient with a
 * funded key from ACR_BUYER_PRIVATE_KEY (server env, never shipped to the
 * browser) and pays the seller's Circle-gated endpoints for real — the same
 * flow as apps/agent/src/payer.ts::GatewayPayer, but reachable from a UI button.
 *
 * NEVER import this from a client component. The key stays on the server; the
 * browser only ever sees settlement results (gateway-ref / tx). */

import "server-only";

/** Per-run USDC spend ceiling — a hard cap mirroring the agent's --limit 0.01.
 *  Real money moves here, so the cap is enforced twice: cumulatively in the
 *  loop and per-payment in the SDK's onBeforePaymentCreation hook (pre-signing). */
export const SPEND_CAP_USDC = 0.01;
/** USDC atomic units (6 decimals). */
const USDC_DECIMALS = 1e6;

/** Structural shape of the bits of GatewayClient we use — keeps this module
 *  decoupled from the SDK's types at build time (mirrors payer.ts). */
interface GatewayClientLike {
  readonly address: `0x${string}`;
  onBeforePaymentCreation(
    hook: (ctx: { selectedRequirements: { amount: string } }) => Promise<void | { abort: true; reason: string }>,
  ): GatewayClientLike;
  pay(
    url: string,
    options?: { method?: "GET" | "POST"; headers?: Record<string, string> },
  ): Promise<{ data: unknown; amount: bigint; formattedAmount: string; transaction: string; status: number }>;
  getBalances(address?: `0x${string}`): Promise<{
    wallet: { balance: bigint; formatted: string };
    gateway: {
      total: bigint;
      available: bigint;
      formattedTotal: string;
      formattedAvailable: string;
      formattedWithdrawing: string;
    };
  }>;
  getUsdcBalance(address?: `0x${string}`): Promise<{ balance: bigint; formatted: string }>;
}

function readKey(): string | null {
  const k = process.env.ACR_BUYER_PRIVATE_KEY?.trim();
  if (!k) return null;
  return k.startsWith("0x") ? k : `0x${k}`;
}

/** True iff a funded buyer key is configured (the UI shows the LIVE controls). */
export function buyerConfigured(): boolean {
  return readKey() !== null;
}

let cached: GatewayClientLike | null = null;

/** Build (once) the GatewayClient against Arc testnet. Throws a readable error
 *  if no key is set so the route can 400 honestly. */
export async function getGatewayClient(): Promise<GatewayClientLike> {
  if (cached) return cached;
  const key = readKey();
  if (!key) throw new Error("no buyer key — set ACR_BUYER_PRIVATE_KEY (a funded EOA with an open Gateway deposit)");
  const { GatewayClient } = (await import("@circle-fin/x402-batching/client")) as {
    GatewayClient: new (cfg: { chain: string; privateKey: `0x${string}` }) => GatewayClientLike;
  };
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: key as `0x${string}` });
  // Pre-signing guard: refuse any single payment above the per-run cap.
  client.onBeforePaymentCreation(async (ctx) => {
    const usdc = Number(ctx.selectedRequirements.amount) / USDC_DECIMALS;
    if (!Number.isFinite(usdc) || usdc > SPEND_CAP_USDC) {
      return { abort: true, reason: `payment ${usdc} USDC exceeds the ${SPEND_CAP_USDC} cap` };
    }
  });
  cached = client;
  return client;
}
