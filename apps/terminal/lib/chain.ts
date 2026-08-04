/* Arc chain constants + explorer-link helpers. Static defaults match the
   testnet; anything the backend knows better arrives via the payload's
   `chain` block and overrides these at render time. */

import type { ChainFactsData } from "./types";

/** ACRFutures.MAX_SETTLE_AGE, in seconds — the window inside which a print is
 *  fresh enough for the venue to settle against.
 *
 *  A copy of an on-chain constant, so it is bound to its source by a test
 *  (lib/chain.test.ts reads contracts/src/ACRFutures.sol and asserts equality).
 *  It was right when it was typed, which is exactly what the `multiplier` bug
 *  was too: that number was also correct once, in an example, in a comment.
 */
export const MAX_SETTLE_AGE_S = 7200;

export const CHAIN = {
  name: "Arc Testnet",
  chainId: 5042002,
  caip2: "eip155:5042002",
  explorer: "https://testnet.arcscan.app",
  rpc: "https://rpc.testnet.arc.network",
  usdc: "0x3600000000000000000000000000000000000000",
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
} as const;

/** Merge payload chain facts over the static defaults. */
export function chainFacts(chain?: ChainFactsData | null) {
  return {
    name: chain?.name ?? CHAIN.name,
    chainId: chain?.chain_id ?? CHAIN.chainId,
    caip2: chain?.caip2 ?? CHAIN.caip2,
    explorer: chain?.explorer_base ?? CHAIN.explorer,
    rpc: chain?.rpc_url ?? CHAIN.rpc,
    usdc: chain?.usdc_address ?? CHAIN.usdc,
    gatewayWallet: chain?.gateway_wallet ?? CHAIN.gatewayWallet,
    oracle: chain?.oracle_address ?? null,
    registry: chain?.registry_address ?? null,
    futures: chain?.futures_address ?? null,
    gate: chain?.gate ?? null,
    tapeSource: chain?.tape_source ?? "sim",
    signer: chain?.signer ?? null,
    poster: chain?.poster ?? null,
  };
}

export function txUrl(hash: string, explorer: string = CHAIN.explorer): string {
  return `${explorer}/tx/${hash}`;
}

export function addrUrl(addr: string, explorer: string = CHAIN.explorer): string {
  return `${explorer}/address/${addr}`;
}

export function blockUrl(n: number, explorer: string = CHAIN.explorer): string {
  return `${explorer}/block/${n}`;
}

export function tokenUrl(addr: string, explorer: string = CHAIN.explorer): string {
  return `${explorer}/token/${addr}`;
}

export function isTxHash(ref: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(ref);
}

export function isHexAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

/** Classify a settlement reference: a real tx hash links to the explorer, a
 *  Gateway batch reference (UUID-ish) is shown as such, and dev-N / sim-N
 *  markers are honestly labeled simulations. */
export type RefKind = "tx" | "gateway-ref" | "sim";

export function refKind(ref: string): RefKind {
  if (isTxHash(ref)) return "tx";
  if (/^(dev|sim)-/.test(ref)) return "sim";
  return "gateway-ref";
}

/* Deterministic identity colors: hash the address into two hues so every
   wallet gets a stable two-stop gradient disc (identicon-lite). */
export function addrGradient(addr: string): string {
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < addr.length; i++) {
    const c = addr.charCodeAt(i);
    h1 = (h1 * 31 + c) % 360;
    h2 = (h2 * 17 + c * 7) % 360;
  }
  return `linear-gradient(135deg, hsl(${h1} 62% 62%), hsl(${h2} 70% 42%))`;
}
