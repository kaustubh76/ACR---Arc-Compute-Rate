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
    attestor: chain?.attestor_address ?? null,
    humanid: chain?.humanid_address ?? null,
    gate: chain?.gate ?? null,
    tapeSource: chain?.tape_source ?? "sim",
    signer: chain?.signer ?? null,
    poster: chain?.poster ?? null,
  };
}

/** One row of the deployed register: what it is, where it lives, how to link it.
 *
 *  The footer and the developers page each hand-rolled this list, and they had
 *  already drifted: the page was missing USDC and the Gateway wallet, and it
 *  resolved the oracle without the payload fallback the footer used. The row
 *  set lives here so a fifth contract is one entry, not two edits. */
export type RegisterEntry = {
  key: "oracle" | "futures" | "registry" | "attestor" | "humanid" | "usdc" | "gateway";
  /** Proper noun. Identical in both editions, so it never goes through <Ed>. */
  name: string;
  addr: string;
  /** Explorer target. USDC is a token page, everything else an address page. */
  href: string;
  /** The two contracts that ARE the product, marked for the gold treatment. */
  primary?: true;
};

/** The deployed set, in the order the paper explains itself: the rate, the
 *  venue, the record, then the money. An unconfigured contract is omitted
 *  rather than rendered as a zero address — the register only ever names
 *  things that exist. `oracleFallback` is the payload's top-level `oracle`,
 *  which is populated on some responses where `chain.oracle_address` is not. */
export function deployedContracts(
  chain?: ChainFactsData | null,
  oracleFallback?: string | null,
): RegisterEntry[] {
  const c = chainFacts(chain);
  const oracle = c.oracle ?? oracleFallback ?? null;
  const at = (addr: string) => addrUrl(addr, c.explorer);

  // Ternaries, not `addr && {…}`: these are `string | null`, so `&&` widens the
  // element type to include the empty string rather than narrowing to null.
  const rows: Array<RegisterEntry | null> = [
    oracle
      ? { key: "oracle", name: "ACROracle", addr: oracle, href: at(oracle), primary: true }
      : null,
    c.futures
      ? {
          key: "futures",
          name: "ACRFutures",
          addr: c.futures,
          href: at(c.futures),
          primary: true,
        }
      : null,
    c.registry
      ? {
          key: "registry",
          name: "AttestationRegistry",
          addr: c.registry,
          href: at(c.registry),
        }
      : null,
    c.attestor
      ? {
          key: "attestor",
          name: "FeedAccessAttestor",
          addr: c.attestor,
          href: at(c.attestor),
        }
      : null,
    // The identity layer. Named here rather than left implicit because the
    // human-denominated bound on /index is only checkable if a reader can find
    // the contract that publishes the clusters it counts.
    c.humanid
      ? {
          key: "humanid",
          name: "HumanIdMirror",
          addr: c.humanid,
          href: at(c.humanid),
        }
      : null,
    // tokenUrl, not addrUrl: USDC is Arc's native gas token and arcscan has a
    // token page for it. The footer linked it that way; a refactor that
    // quietly downgraded it to /address would lose the supply and holders.
    { key: "usdc", name: "USDC", addr: c.usdc, href: tokenUrl(c.usdc, c.explorer) },
    {
      key: "gateway",
      name: "GatewayWallet",
      addr: c.gatewayWallet,
      href: at(c.gatewayWallet),
    },
  ];
  return rows.filter((r): r is RegisterEntry => Boolean(r));
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
