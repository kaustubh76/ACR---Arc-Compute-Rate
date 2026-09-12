/* The agent card, minted where a developer can watch it happen.
 *
 * Isomorphic on purpose. The same function signs a visitor's THROWAWAY card in
 * their browser tab and the demo human's card inside the probe route on the
 * server — two callers, one encoder, so the two cards cannot disagree about the
 * struct. It mirrors `packages/acr_oracle_client/acr_oracle_client/agentcard.py`
 * field for field; the buyer agent's identical encoder is pinned against the Python
 * gate in `tests/test_agent_card_cross_language.py`, and `agentcard.test.ts` pins
 * this one's shape against that.
 *
 * WHY THE DOMAIN NAMES NO CONTRACT. Every other EIP-712 domain in this project
 * binds to a deployed address because a contract verifies it. A card is verified by
 * whoever reads it, so there is nothing to name — and that is what permissionless
 * means here. The cost is paid inside the struct: `audience` stands in for the
 * missing `verifyingContract`, and a 15-minute bound replaces a nonce.
 *
 * viem is imported lazily because the only client that needs it is one button on
 * /developers, and the page's first paint should not carry a signing library.
 */

/** The header the gate reads — `CARD_HEADER` in agentgate.py. */
export const CARD_HEADER = "AGENT-CARD";

export const DOMAIN_NAME = "ACR Agent Card";
export const DOMAIN_VERSION = "1";
export const ZERO32 = `0x${"00".repeat(32)}` as const;

/** `MAX_TTL_S` in agentcard.py. A longer card is refused by the gate, so minting one
 *  is a wasted round trip; clamped here rather than rejected. */
export const MAX_TTL_S = 900;

export const ROLES = ["maker", "taker", "poster", "owner", "reader"] as const;
export type Role = (typeof ROLES)[number];

/** The struct, in the order the Python side hashes it. */
export const AGENT_CARD_TYPES = {
  AgentCard: [
    { name: "agent", type: "address" },
    { name: "name", type: "string" },
    { name: "role", type: "string" },
    { name: "audience", type: "string" },
    { name: "scopeHash", type: "bytes32" },
    { name: "humanCluster", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export interface MintOptions {
  privateKey: `0x${string}`;
  chainId: number;
  /** Who the card is FOR. Read it from `/agent/challenge`, never hardcode it. */
  audience: string;
  name?: string;
  role?: Role;
  ttlSeconds?: number;
  /** A human cluster to CLAIM. Unset claims nothing. The gate refuses a claim it
   *  cannot confirm on chain with a 401, so this is never defaulted. */
  humanCluster?: `0x${string}`;
}

export interface MintedCard {
  /** The base64 header value — what goes in `AGENT-CARD`. */
  header: string;
  /** The signing address, so the UI can show WHO just got a tier. */
  agent: `0x${string}`;
  expiresAt: number;
  claimsHuman: boolean;
}

/** A fresh throwaway key. Lives in memory for as long as the caller keeps it. */
export async function throwawayKey(): Promise<`0x${string}`> {
  const { generatePrivateKey } = await import("viem/accounts");
  return generatePrivateKey();
}

/** Mint, sign, encode. */
export async function mintCard(opts: MintOptions): Promise<MintedCard> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const ttl = Math.min(Math.max(1, Math.floor(opts.ttlSeconds ?? 300)), MAX_TTL_S);
  const account = privateKeyToAccount(opts.privateKey);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttl;

  const message = {
    agent: account.address,
    name: opts.name ?? "acr-developers-page",
    role: opts.role ?? "reader",
    audience: opts.audience,
    scopeHash: ZERO32,
    humanCluster: opts.humanCluster ?? ZERO32,
    issuedAt: BigInt(issuedAt),
    expiresAt: BigInt(expiresAt),
  };

  const signature = await account.signTypedData({
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: opts.chainId },
    types: AGENT_CARD_TYPES,
    primaryType: "AgentCard",
    message,
  });

  // snake_case on the wire, like `AgentCard.to_json`. Names matter, order does not;
  // sorted anyway so two encoders produce byte-identical headers for the same card.
  const card = {
    agent: message.agent,
    audience: message.audience,
    expires_at: expiresAt,
    human_cluster: message.humanCluster,
    issued_at: issuedAt,
    name: message.name,
    role: message.role,
    scope_hash: message.scopeHash,
  };
  // The JSON is ASCII (hex and plain strings), so `btoa` is safe in both runtimes
  // and `Buffer` — Node-only — is not needed.
  const header = btoa(JSON.stringify({ card, signature }));
  return { header, agent: account.address, expiresAt, claimsHuman: message.humanCluster !== ZERO32 };
}

/** The four demo humans' wallet labels, for the probe route's "as a demo human".
 *  Keys derive from these labels exactly as `demo_humans.py` derives them —
 *  `sha256("acr-buyer::" + label)` — which is public by construction. The probe
 *  route derives on the SERVER so no key ever reaches a browser; the browser only
 *  ever sees the resulting header. `acr-buyer-4` is the solo human: the one whose
 *  wallet has the least at stake, and whose cluster is visibly different from the
 *  fleet's three. */
export const DEMO_HUMAN_LABEL = "acr-buyer-4";

/** Derive a demo wallet's key from its label — server-side only. */
export async function demoKey(label: string): Promise<`0x${string}`> {
  const { sha256, toBytes } = await import("viem");
  return sha256(toBytes(`acr-buyer::${label}`));
}
