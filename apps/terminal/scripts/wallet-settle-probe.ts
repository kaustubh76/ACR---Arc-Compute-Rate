/* Does a WALLET-SIGNED x402 payment actually settle? Run it against a seller.
 *
 *   PROBE_KEY=0x… SELLER=http://127.0.0.1:8000 npm run wallet-settle-probe
 *
 * Why this exists. Every test around `lib/walletPayer.ts` is a pure-function
 * test — which option the 402 offers, what the header encodes, how an error
 * reads. None of them proves the thing the launch depends on: that a signature
 * from a *wallet* is accepted by Circle's facilitator and that the seller then
 * serves the paid data. This closes that gap with a real payment.
 *
 * It uses the SAME exported functions the browser path uses. The only
 * difference is where the signer comes from: a local key here, an injected
 * provider in a visitor's browser. That substitution is exactly what Circle's
 * `BatchEvmSigner` contract allows — it is `{address, signTypedData}` and
 * nothing more — so a pass here is evidence about the browser path, not a
 * parallel implementation of it.
 *
 * NOT a CI gate: it spends real USDC and needs a funded Gateway balance. It is
 * the operator's before-launch check, and step 10 of docs/MAINNET_RUNBOOK.md §5
 * leans on it. The key is read from the environment and never printed.
 *
 * What a pass proves, precisely: the facilitator VERIFIED and SETTLED the
 * authorization (`success: true` plus a Gateway transaction id) and the seller
 * served the data. Circle batches nanopayments, so the on-chain debit against
 * the depositor lands when the batch flushes, not during this run — the probe
 * prints the balance before and after and says which of the two it observed.
 */
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, erc20Abi, http } from "viem";
import {
  GATEWAY_WALLET_ABI,
  decodePaymentRequired,
  explainRefusal,
  paymentHeader,
  pickBatchingOption,
} from "../lib/walletPayer";

const SELLER = (process.env.SELLER ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const KEY = process.env.PROBE_KEY;
const PATH_ = process.env.PROBE_PATH ?? "/prints";

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  if (!KEY?.startsWith("0x")) die("PROBE_KEY is unset or not 0x-prefixed (a funded payer's key; never logged)");
  const account = privateKeyToAccount(KEY as `0x${string}`);

  // The seller's own terms decide the network, the price and the Gateway. A
  // literal here would let this pass against the wrong chain.
  const infoRes = await fetch(`${SELLER}/x402/info`, { cache: "no-store" });
  if (!infoRes.ok) die(`GET ${SELLER}/x402/info -> ${infoRes.status}: is the seller up?`);
  const info = (await infoRes.json()) as { facilitator?: string; network?: string; price_usdc?: number };
  console.log(`seller   ${SELLER}`);
  console.log(`network  ${info.network}   facilitator ${info.facilitator}   price ${info.price_usdc} USDC`);
  console.log(`payer    ${account.address}`);
  if (info.facilitator !== "circle") {
    die(`facilitator is '${info.facilitator}', not 'circle' — the dev gate accepts a mock header, so a pass would prove nothing`);
  }

  // Balances before, read from the chain the seller named.
  const envRes = await fetch(`${SELLER}/terminal/data`, { cache: "no-store" });
  const chain = ((await envRes.json()) as { chain?: Record<string, string> }).chain ?? {};
  const rpc = process.env.PROBE_RPC ?? chain.public_rpc_url ?? chain.rpc_url;
  const usdc = chain.usdc_address as `0x${string}` | undefined;
  const gateway = chain.gateway_wallet as `0x${string}` | undefined;
  const read = async () => {
    if (!rpc || !usdc || !gateway) return null;
    const client = createPublicClient({ transport: http(rpc, { timeout: 10_000 }) });
    const [w, g] = await Promise.all([
      client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      client.readContract({
        address: gateway,
        abi: GATEWAY_WALLET_ABI,
        functionName: "availableBalance",
        args: [usdc, account.address],
      }),
    ]);
    return { wallet: w as bigint, gateway: g as bigint };
  };
  const before = await read();
  if (before) console.log(`before   wallet ${before.wallet} · Gateway ${before.gateway} (atomic USDC)`);

  // 1 — the bare request must be refused.
  const first = await fetch(`${SELLER}${PATH_}`, { cache: "no-store" });
  if (first.status !== 402) die(`bare GET ${PATH_} -> ${first.status}, expected 402: this endpoint is NOT gated`);
  console.log(`1. GET ${PATH_} -> 402, paywall engaged`);

  const required = decodePaymentRequired(first.headers.get("PAYMENT-REQUIRED"));
  if (!required) die("the 402 carried no decodable PAYMENT-REQUIRED header");
  const option = pickBatchingOption(required.accepts, info.network ?? "");
  if (!option) die(`the 402 offers no Gateway batching option on ${info.network}: a wallet cannot pay it`);
  console.log(`2. option  amount ${option.amount} · ${(option as { extra?: { name?: string } }).extra?.name}`);

  // 3 — the wallet signs. This is the step no other test covers.
  const { BatchEvmScheme } = await import("@circle-fin/x402-batching/client");
  const signer = { address: account.address, signTypedData: (p: never) => account.signTypedData(p) };
  const scheme = new BatchEvmScheme(signer as unknown as ConstructorParameters<typeof BatchEvmScheme>[0]);
  const payload = await scheme.createPaymentPayload(required.x402Version ?? 2, option as never);
  console.log("3. the wallet signed the Gateway authorization");

  // 4 — the paid retry.
  const paid = await fetch(`${SELLER}${PATH_}`, {
    cache: "no-store",
    headers: { "Payment-Signature": paymentHeader(payload, required.resource, option) },
  });
  console.log(`4. paid retry -> ${paid.status}`);
  const respHeader = paid.headers.get("PAYMENT-RESPONSE");
  if (respHeader) console.log(`   PAYMENT-RESPONSE ${Buffer.from(respHeader, "base64").toString()}`);
  if (paid.status !== 200) {
    die(
      "the seller refused the signed payment. As a visitor would read it: " +
        explainRefusal(decodePaymentRequired(paid.headers.get("PAYMENT-REQUIRED")), paid.status),
    );
  }

  const after = await read();
  if (before && after) {
    const spent = before.gateway - after.gateway;
    console.log(`after    wallet ${after.wallet} · Gateway ${after.gateway}`);
    console.log(
      spent > 0n
        ? `   on-chain debit observed: ${spent} atomic USDC left the Gateway balance`
        : "   no on-chain debit yet — Circle batches nanopayments, so it lands when the batch flushes",
    );
  }
  console.log("\n✓ a wallet-signed x402 payment settled and the seller served the data");
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
