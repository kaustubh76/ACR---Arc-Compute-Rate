/** The paying half: reading what a payer has, and settling an x402 query.
 *
 * Vendored from `apps/agent/src/payer.ts` (+ `receipts.decodeConfirmation`) and
 * `apps/terminal/lib/walletPayer.ts` (the two GatewayWallet fragments and
 * `fundingStep`). This package is published on its own, so it cannot relative-
 * import across the monorepo.
 *
 * WHAT PINS THESE COPIES, stated accurately after the previous version of this
 * sentence promised a `pay.test.ts` that has never existed: `paying.test.ts`
 * exercises `fundingStep`, the spend cap, key validation and the challenge
 * parser against the shapes the originals produce, and `chain.test.ts` parses
 * `acr_core/config.py` and pins the chain table field by field. The vendored
 * GatewayWallet ABI fragments are NOT pinned against `apps/terminal` — they are
 * two function selectors that Circle's own contract defines, and a mismatch
 * surfaces as a failed read rather than a wrong number.
 *
 * WHAT ACTUALLY PAYS. An x402 settlement on Arc spends the payer's **Gateway
 * deposit**, not the USDC sitting in its wallet: the client signs an EIP-3009
 * authorization against the GatewayWallet. So "do I have the money" is two
 * readings, not one, and a wallet with USDC and an empty Gateway balance cannot
 * pay — it has to deposit first. `fundingStep` names which of those a payer is at.
 */

import { USDC_ADDRESS, USDC_DECIMALS, type ArcChain } from "./chain.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PaymentResult {
  status: number;
  data: unknown;
  paidUsdc: number;
  /** Settlement reference — the Gateway tx UUID on the live gate. */
  transaction: string;
  network: string;
  payer: string;
}

/** The two GatewayWallet functions a payer touches — the exact fragments Circle's
 *  SDK carries (`GATEWAY_WALLET_ABI` in @circle-fin/x402-batching/client). */
export const GATEWAY_WALLET_ABI = [
  {
    name: "availableBalance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Where a payer stands against one price. Mirrors `fundingStep` in
 *  `apps/terminal/lib/walletPayer.ts:124`, whose cases are already tested there. */
export type FundingStep = "ready" | "deposit" | "bridge";

export function fundingStep(usdcWallet: number, usdcGateway: number, price: number): FundingStep {
  if (usdcGateway >= Math.max(price, 1e-6)) return "ready";
  if (usdcWallet > 0) return "deposit";
  return "bridge";
}

/** Read the payer's wallet USDC and its Gateway float, both at 6 decimals.
 *
 *  Reads only: this never sends a transaction, so it is safe on the preflight
 *  path where no spending has been authorized. A read that throws comes back as
 *  null rather than zero — "I could not ask" and "it is empty" lead a caller to
 *  opposite conclusions, and reporting the second for the first is how a
 *  preflight tells someone their funded wallet is broke.
 */
export async function readBalances(
  chain: ArcChain,
  owner: `0x${string}`,
): Promise<{ wallet: number | null; gateway: number | null; rpc: string }> {
  const { createPublicClient, http, defineChain, formatUnits } = await import("viem");
  const client = createPublicClient({
    chain: defineChain({
      id: chain.chainId,
      name: chain.name,
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [chain.publicRpc] } },
    }),
    transport: http(chain.publicRpc),
  });

  const num = async (p: Promise<unknown>): Promise<number | null> => {
    try {
      return Number(formatUnits((await p) as bigint, USDC_DECIMALS));
    } catch {
      return null;
    }
  };

  const [wallet, gateway] = await Promise.all([
    num(
      client.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [owner],
      }),
    ),
    num(
      client.readContract({
        address: chain.gatewayWallet,
        abi: GATEWAY_WALLET_ABI,
        functionName: "availableBalance",
        args: [USDC_ADDRESS, owner],
      }),
    ),
  ]);
  return { wallet, gateway, rpc: chain.publicRpc };
}

/** Read the per-query price (USDC decimal) from a 402 challenge. */
export function priceFromChallenge(body: unknown, headers?: Headers): number {
  const accepts = (body as { accepts?: Array<{ amount?: string; maxAmountRequired?: string }> })?.accepts;
  const atomic = accepts?.[0]?.amount ?? accepts?.[0]?.maxAmountRequired;
  if (atomic !== undefined && /^\d+$/.test(atomic)) return Number(atomic) / 1e6;
  const header = headers?.get("X-402-Price");
  if (header !== null && header !== undefined && Number.isFinite(Number(header))) return Number(header);
  throw new Error("402 challenge carries no readable price (accepts[0].amount / X-402-Price)");
}

/** Decode the base64 PAYMENT-RESPONSE / X-PAYMENT-RESPONSE confirmation. */
export function decodeConfirmation(
  headers: Headers,
): { transaction: string; network: string; payer: string } | null {
  const raw = headers.get("PAYMENT-RESPONSE") ?? headers.get("X-PAYMENT-RESPONSE");
  if (!raw) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return {
      transaction: String(obj.transaction ?? obj.txHash ?? ""),
      network: String(obj.network ?? obj.networkId ?? ""),
      payer: String(obj.payer ?? ""),
    };
  } catch {
    return null;
  }
}

/** The slice of the SDK's GatewayClient this payer uses. Named so a test can hand
 *  in a stub without the SDK, and so the header option is part of the contract. */
export interface PayingClient {
  readonly account?: { address: string };
  pay(
    url: string,
    options?: { headers?: Record<string, string> },
  ): Promise<{ data: unknown; formattedAmount: string; transaction: string; status: number }>;
}

/** Real x402: 402 → sign EIP-3009 against the GatewayWallet → retry → settle.
 *  The SDK is a lazy dynamic import, so a server with no payer key never loads
 *  it and `npx acr-mcp` stays fast for the read-only case. */
export class GatewayPayer {
  private constructor(
    readonly address: string,
    private readonly client: PayingClient,
    private readonly chain: ArcChain,
    /** Extra headers for EVERY request the SDK makes — the 402 probe AND the paid
     *  retry — which is how the agent card rides on the settlement itself.
     *  Minted per call, so a card never outlives its own request. */
    private readonly extraHeaders: () => Promise<Record<string, string>> = async () => ({}),
  ) {}

  /** Test seam: a payer over a stubbed client, so the header path can be asserted
   *  without the SDK or a network. */
  static withClient(
    address: string,
    client: PayingClient,
    chain: ArcChain,
    extraHeaders?: () => Promise<Record<string, string>>,
  ): GatewayPayer {
    return new GatewayPayer(address, client, chain, extraHeaders);
  }

  static async create(
    privateKey: string,
    chain: ArcChain,
    extraHeaders?: () => Promise<Record<string, string>>,
  ): Promise<GatewayPayer> {
    const { GatewayClient } = await import("@circle-fin/x402-batching/client");
    /* `arcPrivateMainnet` USED TO BE PASSED HERE AND WAS NEVER READ.
       `GatewayClientConfig` in the installed @circle-fin/x402-batching 3.5.0 is
       `{ chain, privateKey, rpcUrl?, headers? }` — nothing else — and the
       string `arcPrivateMainnet` appears nowhere in the package's shipped JS,
       only in our own call. It compiled because a spread skips excess-property
       checking, and it was then dropped on the floor at runtime. Verified
       2026-10-10 against the typings and the dist.
       It was also unreachable: both profiles are `privateMainnet: false` since
       the private-mainnet preview ended, so the spread never fired. `ArcChain`
       keeps the field because `acr_core/config.py` has it and `chain.test.ts`
       pins the two tables against each other — but nothing downstream of here
       consumes it, and `ACR_ARC_PRIVATE_MAINNET` is documented in the README as
       inert rather than as a switch that does something. */
    const client = new GatewayClient({
      chain: chain.gatewayChain,
      privateKey: privateKey as `0x${string}`,
      rpcUrl: chain.publicRpc,
    }) as unknown as PayingClient;
    return new GatewayPayer(client.account?.address ?? "", client, chain, extraHeaders);
  }

  async pay(url: string): Promise<PaymentResult> {
    const res = await this.client.pay(url, { headers: await this.extraHeaders() });
    return {
      status: res.status,
      data: res.data,
      paidUsdc: Number(res.formattedAmount),
      transaction: res.transaction,
      network: this.chain.caip2,
      payer: this.address,
    };
  }
}

/** Derive the payer's address from its key without loading the Circle SDK — the
 *  preflight needs the address to read balances, and must not need a payer. */
export async function payerAddress(privateKey: string): Promise<`0x${string}`> {
  const { privateKeyToAccount } = await import("viem/accounts");
  return privateKeyToAccount(privateKey.trim() as `0x${string}`).address;
}

/** A ceiling on what one server process may spend, and a tally against it.
 *
 *  A paid query here is $0.0001, which is exactly the amount that makes a looping
 *  agent expensive without ever looking alarming. The cap is per process and
 *  deliberately small by default: a developer proving the loop works needs one
 *  settlement, not a thousand, and anyone who wants a thousand can say so.
 */
export interface SpendLedger {
  spentUsdc: number;
  calls: number;
  maxUsdc: number;
}

/** USDC is an integer of millionths. Comparing a running total against a cap in
 *  floating point gets the boundary wrong — three $0.0001 calls sum to
 *  0.00030000000000000003, which is over a $0.0003 cap by 3e-20 — and the one
 *  place a rounding error must not land is the thing deciding whether to spend. */
const MICRO = 1_000_000;
const micros = (usdc: number): number => Math.round(usdc * MICRO);

/** `ACR_MAX_SPEND_USDC`, or a cent.
 *
 *  An UNSET variable must not read as a cap of zero: `Number("")` is 0, which is
 *  finite and non-negative, so the obvious parse turned "the developer said
 *  nothing" into "the developer said never pay" and disabled the tool by default.
 *  A deliberate "0" still means zero — it is a useful state to configure. */
export function newLedger(raw?: string): SpendLedger {
  const text = (raw ?? "").trim();
  if (text === "") return { spentUsdc: 0, calls: 0, maxUsdc: 0.01 };
  const parsed = Number(text);
  const maxUsdc = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.01;
  return { spentUsdc: 0, calls: 0, maxUsdc };
}

export function admits(l: SpendLedger, amount: number): { ok: true } | { ok: false; reason: string } {
  const wouldMicros = micros(l.spentUsdc) + Math.max(micros(amount), 0);
  if (wouldMicros > micros(l.maxUsdc)) {
    return {
      ok: false,
      reason:
        `this would spend $${(wouldMicros / MICRO).toFixed(6)} in one session, over the ` +
        `$${l.maxUsdc} cap (${l.calls} call${l.calls === 1 ? "" : "s"}, ` +
        `$${l.spentUsdc.toFixed(6)} so far). ` +
        "Raise ACR_MAX_SPEND_USDC in the host config if that is intended.",
    };
  }
  return { ok: true };
}

export function record(l: SpendLedger, amount: number): void {
  l.spentUsdc = (micros(l.spentUsdc) + Math.max(micros(amount), 0)) / MICRO;
  l.calls += 1;
}

/** A 32-byte hex key, or an explanation. Shaped after the check in
 *  `apps/agent/src/deposit.ts:42`, which names the length it actually got —
 *  a truncated paste is the common failure and "invalid key" does not locate it. */
export function validateKey(raw: string): { key: `0x${string}` } | { reason: string } {
  const trimmed = (raw ?? "").trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    return {
      reason:
        `not a 32-byte hex key (got ${hex.length} hex characters after trimming, wanted 64). ` +
        "Expected 0x followed by 64 hex characters.",
    };
  }
  return { key: `0x${hex}` };
}
