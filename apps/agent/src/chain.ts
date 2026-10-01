/* Which Arc the agent is on, from one variable — never a literal in a payer.
 *
 * Mirrors `acr_core.config.CHAIN_PROFILES`. Mainnet values come from docs.arc.io
 * and developers.circle.com (read 2026-09-18, re-probed 2026-09-21: the mainnet
 * RPC is public and Gateway lists Arc without the private-preview header); testnet
 * values are the ones this agent has paid on since July. The Unified Balance Kit
 * names mainnet `Arc` from 1.7.0 (1.3.1 knew `Arc_Testnet` only), which is why the
 * dependency is pinned there. AGENT_UBK_CHAIN still overrides it. */

export interface AgentChain {
  chainId: number;
  caip2: `eip155:${number}`;
  /** `@circle-fin/x402-batching` chain key. */
  gatewayChain: "arcTestnet" | "arc";
  /** `@circle-fin/unified-balance-kit` chain name; null = this kit cannot deposit here. */
  ubkChain: string | null;
  /** Send Gateway the Arc private-mainnet header (harmless now the preview ended). */
  privateMainnet: boolean;
}

const PROFILES: Record<number, AgentChain> = {
  5042002: {
    chainId: 5042002,
    caip2: "eip155:5042002",
    gatewayChain: "arcTestnet",
    ubkChain: "Arc_Testnet",
    privateMainnet: false,
  },
  5042: {
    chainId: 5042,
    caip2: "eip155:5042",
    gatewayChain: "arc",
    ubkChain: "Arc",
    privateMainnet: false,
  },
};

/** Resolve from the environment. Unknown ids are refused loudly rather than paid on. */
export function agentChain(env: NodeJS.ProcessEnv = process.env): AgentChain {
  // Arc MAINNET. The default was 5042002, and NOTHING set this variable —
  // not the README, not the docs — so the one command the README gives for
  // this agent (`--api https://acr-api-mainnet.onrender.com`) built x402
  // payments for eip155:5042002 and offered them to a mainnet seller. The
  // header above says "from one variable — never a literal in a payer"; the
  // literal was here, and it was the chain this project had left.
  const raw = (env.ACR_ARC_CHAIN_ID ?? "5042").trim();
  const id = Number(raw);
  const prof = PROFILES[id];
  if (!prof) throw new Error(`ACR_ARC_CHAIN_ID=${raw}: not an Arc network this agent knows how to pay on`);
  const ubk = (env.AGENT_UBK_CHAIN ?? "").trim();
  const priv = (env.ACR_ARC_PRIVATE_MAINNET ?? "").trim();
  return {
    ...prof,
    ...(ubk ? { ubkChain: ubk } : {}),
    ...(priv ? { privateMainnet: priv !== "0" && priv.toLowerCase() !== "false" } : {}),
  };
}
