/** Which Arc a tool is talking to, and the few addresses a payment check needs.
 *
 * Mirrors `packages/acr_core/acr_core/config.py:CHAIN_PROFILES` — the canonical
 * table — and `apps/agent/src/chain.ts`, which mirrors the same thing for the
 * buyer agent. Three copies is two too many, but the alternative for a package
 * published on its own is a runtime dependency on the monorepo, so the drift is
 * pinned by a test instead (`chain.test.ts`).
 *
 * WHY A TABLE AND NOT AN ENV VAR. `apps/agent/src/chain.ts:40-45` records what
 * happened when the chain was a default nobody set: the agent built x402
 * payments for eip155:5042002 and offered them to a mainnet seller. Here the
 * chain id is not defaulted at all — it comes from the gate's own
 * `/agent/challenge` (see `card.ts:gateChainId`), and this table only answers
 * "given that chain, which RPC and which Gateway". An id with no row is
 * reported as unknown rather than guessed.
 */

export interface ArcChain {
  chainId: number;
  caip2: `eip155:${number}`;
  name: string;
  /** Public RPC. Reads only — this package never sends a transaction through it. */
  publicRpc: string;
  /** Circle Gateway custody for this chain: where a payer's x402 float is held. */
  gatewayWallet: `0x${string}`;
  /** `@circle-fin/x402-batching` chain key. */
  gatewayChain: "arc" | "arcTestnet";
  explorer: string;
  privateMainnet: boolean;
}

/** USDC on Arc, the same predeploy on both networks, and what the 402 challenge
 *  names as its `asset`. Six decimals — the ERC-20 view, never the 18-decimal
 *  native one, which is a balance of the same money reported in different units. */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;
export const USDC_DECIMALS = 6;

const PROFILES: Record<number, ArcChain> = {
  5042: {
    chainId: 5042,
    caip2: "eip155:5042",
    name: "Arc",
    publicRpc: "https://rpc.mainnet.arc.io",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayChain: "arc",
    explorer: "https://explorer.arc.io",
    privateMainnet: false,
  },
  5042002: {
    chainId: 5042002,
    caip2: "eip155:5042002",
    name: "Arc Testnet",
    publicRpc: "https://rpc.testnet.arc.io",
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayChain: "arcTestnet",
    explorer: "https://testnet.arcscan.app",
    privateMainnet: false,
  },
};

/** The Arcs this package knows how to check a payment on. */
export function knownChainIds(): number[] {
  return Object.keys(PROFILES).map(Number);
}

/** Resolve a chain id to its profile, with `ACR_ARC_RPC_URL` overriding the RPC
 *  (a keyed endpoint, or a local node). Null for an id with no row: the caller
 *  reports "this host is on a chain I have no profile for", which is a true
 *  statement, rather than reaching for whichever profile happens to be first. */
export function arcChain(chainId: number, env: NodeJS.ProcessEnv = process.env): ArcChain | null {
  const prof = PROFILES[chainId];
  if (!prof) return null;
  const rpc = (env.ACR_ARC_RPC_URL ?? "").trim();
  const priv = (env.ACR_ARC_PRIVATE_MAINNET ?? "").trim();
  return {
    ...prof,
    ...(rpc ? { publicRpc: rpc } : {}),
    ...(priv ? { privateMainnet: priv !== "0" && priv.toLowerCase() !== "false" } : {}),
  };
}
