/** The two payers behind one interface.
 *
 * DevPayer mirrors the DevFacilitator's mock header — zero Circle imports, so
 * the credential-free demo never touches the SDK. GatewayPayer wraps Circle's
 * official GatewayClient (lazy dynamic import, only reached with --live):
 * real x402 — 402 → sign EIP-3009 against the GatewayWallet → retry → settle.
 */

import { decodeConfirmation } from "./receipts.js";

export interface PaymentResult {
  status: number;
  data: unknown;
  paidUsdc: number;
  /** Settlement reference — Gateway tx UUID live, "dev-N" against the mock gate. */
  transaction: string;
  network: string;
  payer: string;
}

export interface Payer {
  readonly label: string;
  readonly address: string;
  pay(url: string): Promise<PaymentResult>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Read the per-query price (USDC decimal) from a 402 challenge. */
export function priceFromChallenge(body: unknown, headers: Headers): number {
  const accepts = (body as { accepts?: Array<{ amount?: string; maxAmountRequired?: string }> })
    ?.accepts;
  const atomic = accepts?.[0]?.amount ?? accepts?.[0]?.maxAmountRequired;
  if (atomic !== undefined && /^\d+$/.test(atomic)) return Number(atomic) / 1e6;
  const header = headers.get("X-402-Price");
  if (header !== null && Number.isFinite(Number(header))) return Number(header);
  throw new Error("402 challenge carries no readable price (accepts[0].amount / X-402-Price)");
}

export class DevPayer implements Payer {
  readonly label = "dev (mock header)";

  constructor(
    readonly address: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async pay(url: string): Promise<PaymentResult> {
    const r1 = await this.fetchImpl(url);
    if (r1.status !== 402) {
      if (r1.ok) {
        return {
          status: r1.status, data: await r1.json(), paidUsdc: 0,
          transaction: "", network: "", payer: this.address,
        };
      }
      throw new Error(`expected 402 challenge, got ${r1.status}`);
    }
    const challenge = await r1.json().catch(() => ({}));
    const price = priceFromChallenge(challenge, r1.headers);
    const r2 = await this.fetchImpl(url, {
      headers: { "PAYMENT-SIGNATURE": `x402 ${this.address}:${price}` },
    });
    if (!r2.ok) throw new Error(`payment rejected with ${r2.status}`);
    const confirmation = decodeConfirmation(r2.headers);
    return {
      status: r2.status,
      data: await r2.json(),
      paidUsdc: price,
      transaction: confirmation?.transaction ?? "dev-settled",
      network: confirmation?.network ?? "eip155:5042002",
      payer: confirmation?.payer || this.address,
    };
  }
}

/** The slice of the SDK's GatewayClient this payer uses. Named so a test can hand
 *  in a stub without the SDK, and so the header option is part of the contract. */
export interface PayingClient {
  pay(url: string, options?: { headers?: Record<string, string> }): Promise<{
    data: unknown; formattedAmount: string; transaction: string; status: number;
  }>;
}

export class GatewayPayer implements Payer {
  readonly label = "circle gateway (x402, arcTestnet)";

  private constructor(
    readonly address: string,
    private readonly client: PayingClient,
    /** Extra headers for EVERY request the SDK makes — the 402 probe AND the paid
     *  retry. This is how the agent card rides on the settlement itself. The SDK
     *  spreads `options.headers` into both requests before adding
     *  `Payment-Signature`, which the previous reading of it ("owns the whole
     *  request, cannot merge a header") got wrong: the option is there. Minted per
     *  call, so a card never outlives its own request. */
    private readonly extraHeaders: () => Promise<Record<string, string>> = async () => ({}),
  ) {}

  /** Test seam: a payer over a stubbed client, so the header path can be asserted
   *  without the SDK or a network. The only other way in is `create`, which
   *  imports the real SDK and would make the test depend on it being installed. */
  static withClient(
    address: string,
    client: PayingClient,
    extraHeaders?: () => Promise<Record<string, string>>,
  ): GatewayPayer {
    return new GatewayPayer(address, client, extraHeaders);
  }

  /** Lazy-import the SDK so dev mode never loads (or needs) it. */
  static async create(
    privateKey: string,
    extraHeaders?: () => Promise<Record<string, string>>,
  ): Promise<GatewayPayer> {
    const { GatewayClient } = await import("@circle-fin/x402-batching/client");
    const client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: privateKey as `0x${string}`,
    });
    return new GatewayPayer(client.account.address, client, extraHeaders);
  }

  async pay(url: string): Promise<PaymentResult> {
    const res = await this.client.pay(url, { headers: await this.extraHeaders() });
    return {
      status: res.status,
      data: res.data,
      paidUsdc: Number(res.formattedAmount),
      transaction: res.transaction,
      network: "eip155:5042002",
      payer: this.address,
    };
  }
}
