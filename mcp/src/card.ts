/* The agent card this MCP server presents — so an agent using ACR through Claude
 * is a CARDED caller, not an anonymous one.
 *
 * This server is literally an agent calling ACR: every tool is a request an LLM
 * decided to make. It was the most natural consumer of the gate and, for a day,
 * the only caller in the repo that presented nothing. Same encoder as
 * apps/agent/src/card.ts — the two must not drift, and the Python gate they both
 * talk to is pinned in tests/test_agent_card_cross_language.py.
 *
 * Opt-in. No ACR_AGENT_PRIVATE_KEY means no header and an anonymous call, which is
 * a working state. ACR_AGENT_HUMAN_CLUSTER is a claim the gate verifies on chain and
 * refuses with a 401 if it cannot confirm — a wrong value turns every tool into a
 * 401, so it is never defaulted.
 */

import { privateKeyToAccount } from "viem/accounts";

import type { Fetchish } from "./tools.js";

export const CARD_HEADER = "AGENT-CARD";
const DOMAIN_NAME = "ACR Agent Card";
const DOMAIN_VERSION = "1";
const ZERO32 = `0x${"00".repeat(32)}` as const;
export const MAX_TTL_S = 900;

const TYPES = {
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

export interface CardOptions {
  privateKey: `0x${string}`;
  chainId: number;
  audience?: string;
  name?: string;
  role?: "maker" | "taker" | "poster" | "owner" | "reader";
  ttlSeconds?: number;
  humanCluster?: `0x${string}`;
}

export async function mintCardHeader(opts: CardOptions): Promise<string> {
  const ttl = Math.min(Math.max(1, Math.floor(opts.ttlSeconds ?? 300)), MAX_TTL_S);
  const account = privateKeyToAccount(opts.privateKey);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttl;
  const message = {
    agent: account.address,
    name: opts.name ?? "acr-mcp",
    role: opts.role ?? "reader",
    audience: opts.audience ?? "acr-index-api",
    scopeHash: ZERO32,
    humanCluster: opts.humanCluster ?? ZERO32,
    issuedAt: BigInt(issuedAt),
    expiresAt: BigInt(expiresAt),
  };
  const signature = await account.signTypedData({
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: opts.chainId },
    types: TYPES,
    primaryType: "AgentCard",
    message,
  });
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
  return Buffer.from(JSON.stringify({ card, signature }), "utf8").toString("base64");
}

/** Wrap the server's fetch so EVERY tool call carries a fresh card. One wrap, in
 *  server.ts, covers every tool — including query_tape's direct POST — because
 *  they all go through the same `f`. With no key the fetch is returned unchanged. */
export function withCard(fetchImpl: Fetchish, opts: Partial<CardOptions> & { chainId: number }): Fetchish {
  const key = (opts.privateKey ?? "").trim();
  if (!key) return fetchImpl;
  return async (url, init) => {
    let header: string;
    try {
      header = await mintCardHeader({ ...opts, privateKey: key as `0x${string}` });
    } catch {
      return fetchImpl(url, init); // a key that cannot sign is a config problem, not a reason to refuse the tool
    }
    return fetchImpl(url, { ...(init ?? {}), headers: { ...(init?.headers ?? {}), [CARD_HEADER]: header } });
  };
}
