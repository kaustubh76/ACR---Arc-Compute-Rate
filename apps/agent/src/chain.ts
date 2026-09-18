/* Which Arc the agent is on, from one variable — never a literal in a payer.
 *
 * Mirrors `acr_core.config.CHAIN_PROFILES`. Mainnet values come from docs.arc.io
 * and developers.circle.com (read 2026-09-18); testnet values are the ones this
 * agent has paid on since July. The Unified Balance Kit (1.3.1) has NO Arc mainnet
 * identifier — its enum holds `Arc_Testnet` only — so `ubkChain` is null there and
 * the kit-based deposit refuses rather than guess a name the kit would reject.
 * AGENT_UBK_CHAIN overrides it once a kit version that knows mainnet ships. */

export interface AgentChain {
  chainId: number;
  caip2: `eip155:${number}`;
  /** `@circle-fin/x402-batching` chain key. */
  gatewayChain: "arcTestnet" | "arc";
  /** `@circle-fin/unified-balance-kit` chain name; null = this kit cannot deposit here. */
  ubkChain: string | null;
  /** Arc mainnet is a permissioned preview until GA. */
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
    ubkChain: null, // kit 1.3.1 has no mainnet Arc; see the header
    privateMainnet: true,
  },
};

/** Resolve from the environment. Unknown ids are refused loudly rather than paid on. */
export function agentChain(env: NodeJS.ProcessEnv = process.env): AgentChain {
  const raw = (env.ACR_ARC_CHAIN_ID ?? "5042002").trim();
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
