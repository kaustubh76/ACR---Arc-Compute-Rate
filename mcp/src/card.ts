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

/** Where a card's chain id comes from: a literal, or something that goes and asks.
 *  Null from a resolver means "could not establish it", and the caller sends no
 *  card rather than one signed for a guess. */
export type ChainIdSource = number | (() => Promise<number | null>);

/** The last-resort chain id, used only when the gate cannot be reached AND no
 *  override is set. Arc testnet, which is the host the published config names. */
export const FALLBACK_CHAIN_ID = 5042002;

/** Ask the gate which chain it verifies cards for, and cache the answer.
 *
 * THE BUG THIS EXISTS FOR. The chain id is inside the EIP-712 domain, so it is
 * part of the signature: sign for one chain, present to a gate expecting
 * another, and the gate recovers a different address and answers
 * `401 "agent card signature does not match its agent"`. `DEFAULT_API` named the
 * mainnet press while this id defaulted to Arc testnet, and nothing — not
 * `mcp/README.md`, not the snippet on `/developers` — set the variable that
 * reconciled them. Measured 2026-10-08 against the config in the README: four of
 * five tools 401, the fifth failed downstream of it. Every one of the 16 tests
 * passed, because they fake `fetch`.
 *
 * So the id is not defaulted any more. `GET /agent/challenge` answers 200 with
 * its own `chain_id` to an uncarded caller — the gate states which chain it is
 * on, and we sign for that. `ACR_ARC_CHAIN_ID` still wins, for a fork or a local
 * gate; the literal above is only reached when neither is available.
 *
 * Takes the RAW fetch, never the carded one: the probe that decides what the
 * card says cannot itself be wrapped in a card.
 */
export function gateChainId(
  rawFetch: Fetchish,
  api: string,
  override?: string,
): () => Promise<number | null> {
  const explicit = Number((override ?? "").trim());
  if (Number.isFinite(explicit) && explicit > 0) return async () => explicit;

  // Only a success is cached. Caching a failure would let one cold start on a
  // sleeping free-tier press demote the whole session to anonymous.
  let settled: number | null = null;
  return async () => {
    if (settled !== null) return settled;
    try {
      const res = await rawFetch(`${api.replace(/\/$/, "")}/agent/challenge`);
      const body = (await res.json().catch(() => ({}))) as { chain_id?: unknown };
      const id = Number(body?.chain_id);
      if (Number.isFinite(id) && id > 0) {
        settled = id;
        return id;
      }
    } catch {
      /* unreachable gate — fall through */
    }
    return null;
  };
}

/** Wrap the server's fetch so EVERY tool call carries a fresh card. One wrap, in
 *  server.ts, covers every tool — including query_tape's direct POST — because
 *  they all go through the same `f`. With no key the fetch is returned unchanged.
 *
 *  With a key but no resolvable chain id, the call also goes out unchanged. An
 *  anonymous caller is a documented working state on a lower rate-limit bucket;
 *  a card signed for the wrong chain is a 401 on every tool, which is strictly
 *  worse than not presenting one. */
export function withCard(
  fetchImpl: Fetchish,
  // Omit before intersecting: `Partial<CardOptions>` already carries
  // `chainId?: number`, and the intersection would be `number & ChainIdSource`.
  opts: Omit<Partial<CardOptions>, "chainId"> & { chainId: ChainIdSource },
): Fetchish {
  const key = (opts.privateKey ?? "").trim();
  if (!key) return fetchImpl;
  const resolve = typeof opts.chainId === "function" ? opts.chainId : async () => opts.chainId as number;
  return async (url, init) => {
    let header: string;
    try {
      const chainId = await resolve();
      if (chainId === null) return fetchImpl(url, init);
      header = await mintCardHeader({ ...opts, chainId, privateKey: key as `0x${string}` });
    } catch {
      return fetchImpl(url, init); // a key that cannot sign is a config problem, not a reason to refuse the tool
    }
    return fetchImpl(url, { ...(init ?? {}), headers: { ...(init?.headers ?? {}), [CARD_HEADER]: header } });
  };
}
