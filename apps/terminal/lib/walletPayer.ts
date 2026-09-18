/* Pay for the product from the visitor's OWN wallet — the human revenue path.
 *
 * Until this existed every purchase button on the terminal routed through the
 * operator's server-held key: a demo, not revenue, and off on mainnet. A human
 * with USDC on Arc could not buy a print. This is the same x402 protocol the
 * agents use — one gate, one receipts tape, no fork in the payment model — with
 * the browser wallet as the signer. Circle's SDK accepts any `{address,
 * signTypedData}` as a signer, which is exactly what an injected wallet is.
 *
 * Three steps, each honest about what it needs:
 *   1. connect — the wallet, on the chain the SELLER reports (added if missing);
 *   2. deposit — USDC into Circle's GatewayWallet (approve + deposit, from the
 *      wallet), because x402 batching pays from a Gateway balance, not a wallet
 *      balance;
 *   3. pay — GET the gated URL, take the 402, sign the batching authorization,
 *      retry with `Payment-Signature`, read the receipt.
 *
 * Pure decisions (which 402 option, what the header is, what an "add chain"
 * request looks like) are exported so they are tested without a wallet. Chain
 * facts come from the payload (`chainFacts`), never a literal here — the same
 * code pays on testnet today and on mainnet at GA. During Arc mainnet's
 * permissioned preview a visitor's wallet has no public RPC to reach, which is
 * an external limit this file states rather than hides. */

import { createWalletClient, custom, defineChain, erc20Abi, parseUnits, type Hex, type WalletClient } from "viem";
import type { chainFacts } from "./chain";

export type Facts = ReturnType<typeof chainFacts>;

/** The two GatewayWallet functions a payer touches — the exact fragments Circle's
 *  SDK carries (`GATEWAY_WALLET_ABI` in @circle-fin/x402-batching/client). */
export const GATEWAY_WALLET_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
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

/** One 402 option, as the seller's PAYMENT-REQUIRED header carries it. */
export interface PaymentOption {
  scheme: string;
  network: string;
  amount: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string; verifyingContract?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface PaymentRequired {
  x402Version?: number;
  accepts?: PaymentOption[];
  resource?: unknown;
  [k: string]: unknown;
}

/** The Circle batching option for THIS network, or null. Mirrors the SDK's own
 *  selection: same network, `extra.name === "GatewayWalletBatched"`, a verifying
 *  contract present. A seller that offers only plain `exact` is not payable
 *  from a Gateway balance and the caller says so. */
export function pickBatchingOption(accepts: PaymentOption[] | undefined, network: string): PaymentOption | null {
  for (const o of accepts ?? []) {
    if (o.network !== network) continue;
    if (o.extra?.name !== "GatewayWalletBatched") continue;
    if (typeof o.extra?.verifyingContract !== "string") continue;
    return o;
  }
  return null;
}

/** The `Payment-Signature` header value — byte-for-byte what Circle's GatewayClient
 *  sends: base64 of `{...payload, resource, accepted}`. UTF-8 safe. */
export function paymentHeader(
  payload: { x402Version: number; payload: unknown },
  resource: unknown,
  accepted: PaymentOption,
): string {
  return b64encode(JSON.stringify({ ...payload, resource, accepted }));
}

export function decodePaymentRequired(header: string | null): PaymentRequired | null {
  if (!header) return null;
  try {
    return JSON.parse(b64decode(header)) as PaymentRequired;
  } catch {
    return null;
  }
}

/** EIP-3085 params for `wallet_addEthereumChain`, from the payload's chain facts.
 *  Arc's native asset IS USDC (18-decimal native view), so that is what a wallet
 *  must be told, or it renders gas in a token that does not exist. */
export function addChainParams(f: Facts) {
  return {
    chainId: `0x${f.chainId.toString(16)}`,
    chainName: f.name,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: f.rpc ? [f.rpc] : [],
    blockExplorerUrls: f.explorer ? [f.explorer] : [],
  };
}

/** USDC amounts are 6-decimal on the ERC-20 view — never the 18-decimal native one. */
export function usdcUnits(amountUsdc: number | string): bigint {
  return parseUnits(String(amountUsdc), 6);
}

// ---------------------------------------------------------------- browser side

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

export function injectedProvider(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  return eth ?? null;
}

export interface WalletSession {
  client: WalletClient;
  address: `0x${string}`;
}

/** Connect the injected wallet and put it on the seller's chain — switching, or
 *  adding it when the wallet has never heard of Arc (EIP-3085). */
export async function connectWallet(f: Facts): Promise<WalletSession> {
  const eth = injectedProvider();
  if (!eth) throw new Error("no wallet found in this browser — install one, or use the Desk");
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts?.[0] as `0x${string}` | undefined;
  if (!address) throw new Error("the wallet returned no account");
  const hexId = `0x${f.chainId.toString(16)}`;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902) throw e; // 4902: unknown chain → add it
    if (!f.rpc) {
      // Arc mainnet's permissioned preview: there is no public RPC to give the
      // wallet, so it cannot be added. Say so, and name the path that works.
      throw new Error(
        `${f.name} is not in your wallet and has no public RPC yet (permissioned preview). ` +
          "Pay through the Desk pass for now, or come back at mainnet GA.",
      );
    }
    await eth.request({ method: "wallet_addEthereumChain", params: [addChainParams(f)] });
  }
  const client = createWalletClient({ chain: viemChain(f), transport: custom(eth), account: address });
  return { client, address };
}

export function viemChain(f: Facts) {
  return defineChain({
    id: f.chainId,
    name: f.name,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: f.rpc ? [f.rpc] : [] } },
    blockExplorers: f.explorer ? { default: { name: "explorer", url: f.explorer } } : undefined,
  });
}

/** approve + deposit into Circle's GatewayWallet, from the visitor's wallet. Two
 *  transactions the wallet shows and the visitor signs. Returns both hashes. */
export async function depositToGateway(
  s: WalletSession,
  f: Facts,
  amountUsdc: number | string,
): Promise<{ approve: Hex; deposit: Hex }> {
  const value = usdcUnits(amountUsdc);
  const usdc = f.usdc as `0x${string}`;
  const gateway = f.gatewayWallet as `0x${string}`;
  const chain = viemChain(f);
  const approve = await s.client.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [gateway, value],
    chain,
    account: s.address,
  });
  const deposit = await s.client.writeContract({
    address: gateway,
    abi: GATEWAY_WALLET_ABI,
    functionName: "deposit",
    args: [usdc, value],
    chain,
    account: s.address,
  });
  return { approve, deposit };
}

export interface WalletPayResult {
  status: number;
  /** The seller's PAYMENT-RESPONSE, decoded — the Gateway batch reference lives here. */
  receipt: { success?: boolean; transaction?: string; network?: string; payer?: string } | null;
  body: unknown;
  amountUsdc: number;
}

/** The two-act exchange, signed by the visitor: 402 → authorization → paid retry. */
export async function payWithWallet(s: WalletSession, f: Facts, url: string): Promise<WalletPayResult> {
  const first = await fetch(url, { cache: "no-store" });
  if (first.status !== 402) {
    return { status: first.status, receipt: null, body: await first.json().catch(() => null), amountUsdc: 0 };
  }
  const required = decodePaymentRequired(first.headers.get("PAYMENT-REQUIRED"));
  if (!required) throw new Error("the seller's 402 carried no PAYMENT-REQUIRED header");
  const option = pickBatchingOption(required.accepts, f.caip2);
  if (!option) {
    throw new Error(`the seller offers no Gateway batching option on ${f.caip2} — a wallet cannot pay it`);
  }
  const { BatchEvmScheme } = await import("@circle-fin/x402-batching/client");
  const signer = {
    address: s.address,
    signTypedData: (params: Parameters<WalletClient["signTypedData"]>[0]) =>
      s.client.signTypedData({ ...params, account: s.address } as Parameters<WalletClient["signTypedData"]>[0]),
  };
  const scheme = new BatchEvmScheme(signer as ConstructorParameters<typeof BatchEvmScheme>[0]);
  const payload = await scheme.createPaymentPayload(required.x402Version ?? 2, option as never);
  const paid = await fetch(url, {
    cache: "no-store",
    headers: { "Payment-Signature": paymentHeader(payload, required.resource, option) },
  });
  const receiptHeader = paid.headers.get("PAYMENT-RESPONSE");
  let receipt: WalletPayResult["receipt"] = null;
  if (receiptHeader) {
    try {
      receipt = JSON.parse(b64decode(receiptHeader));
    } catch {
      receipt = null;
    }
  }
  return {
    status: paid.status,
    receipt,
    body: await paid.json().catch(() => null),
    amountUsdc: Number(option.amount) / 1e6,
  };
}

// ---------------------------------------------------------------- base64, utf-8 safe

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): string {
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
