/* The agent card this agent presents — the caller half of the gate.
 *
 * The API has verified cards since `45c64e6` and nothing in the repo ever sent
 * one, which is a feature that exists only in its own tests. This is the first
 * real caller, and the buyer agent is the honest choice for it: it is an
 * autonomous process with its own key (`AGENT_PRIVATE_KEY`), which is exactly
 * what the card identifies.
 *
 * WHY NOT THE TERMINAL, which was the obvious candidate and has viem and a key
 * already. Every human reader shares that one server-side process, so one card
 * would mean one identity and therefore ONE rate-limit bucket for every reader at
 * once — recreating the global-limit-behind-a-proxy problem the card exists to
 * fix, and relabelling browser traffic as agent-to-agent traffic on the way. A
 * website's proxy is not an agent. It stays anonymous deliberately.
 *
 * The signature is EIP-712 over a domain with NO `verifyingContract`, which is
 * what makes the card permissionless: there is no registry to look it up in. viem
 * derives the `EIP712Domain` type from the keys actually present, so a 3-field
 * domain signs correctly here — the same reason the Python `LocalKeySigner` works
 * and Circle custody does not (see `sign_card`, which refuses it outright).
 */

import { privateKeyToAccount } from "viem/accounts";

// The loop's own fetch type, imported rather than redeclared: a second
// structurally-similar FetchLike is the kind of near-duplicate that typechecks
// everywhere except the one call site that matters.
import type { FetchLike } from "./payer.js";

/** The header the gate reads. Matches `CARD_HEADER` in agentgate.py. */
export const CARD_HEADER = "AGENT-CARD";

const DOMAIN_NAME = "ACR Agent Card";
const DOMAIN_VERSION = "1";
const ZERO32 = `0x${"00".repeat(32)}` as const;

/** The signer's bound, mirrored from `MAX_TTL_S` in agentcard.py. A card asking
 *  for longer is refused BY THE GATE, so minting one is a wasted round trip. */
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
  /** 32-byte hex key. Normalised by the caller (`normalizePrivateKey`). */
  privateKey: `0x${string}`;
  chainId: number;
  /** Who the card is FOR. This stands in for the missing `verifyingContract`, so
   *  a card minted for one service is refused by another. */
  audience?: string;
  name?: string;
  role?: "maker" | "taker" | "poster" | "owner" | "reader";
  ttlSeconds?: number;
  /** The human cluster this agent CLAIMS, as 32 bytes of hex. Leave unset to
   *  claim nothing. The gate verifies a claim against `HumanIdMirror.clusterOf` on
   *  chain and refuses a card whose claim it cannot confirm — a 401, not a
   *  downgrade — so a wrong value stops the buying loop rather than quietly
   *  demoting it. Opt-in for exactly that reason. */
  humanCluster?: `0x${string}`;
}

/** Mint, sign and encode one card. Returns the base64 header value.
 *
 *  Short-lived by design: a bearer credential is replayable until it expires, and
 *  `MAX_TTL_S` is enforced at the gate as well as here, because a hostile agent
 *  does not call this function.
 */
export async function mintCardHeader(opts: CardOptions): Promise<string> {
  const ttl = Math.min(Math.max(1, Math.floor(opts.ttlSeconds ?? 300)), MAX_TTL_S);
  const account = privateKeyToAccount(opts.privateKey);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttl;

  const message = {
    agent: account.address,
    name: opts.name ?? "acr-buyer-agent",
    role: opts.role ?? "taker",
    audience: opts.audience ?? "acr-index-api",
    scopeHash: ZERO32,
    // Claim a human only when told to. A claim the chain cannot confirm is a 401
    // rather than a downgrade, so an agent that is not resolved must claim
    // nothing — and `withCard` never invents one.
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

  // snake_case and sorted keys, matching `encode_header`: the gate re-reads this
  // object, and two encoders that disagree about key order would still verify,
  // but two that disagree about NAMES would not.
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

/** Wrap a fetch so every outbound request carries a FRESH card.
 *
 *  Per request rather than cached for the TTL: signing is local and costs
 *  microseconds, while a cached card is a credential sitting in memory getting
 *  closer to the replay window's edge. The cheap thing is also the safe thing, so
 *  there is nothing to trade.
 *
 *  With no key, returns the fetch UNCHANGED — no header, today's behaviour
 *  exactly. An agent with no card is served anonymously, which is a working
 *  state and not an error worth crashing a buyer loop over.
 */
export function withCard(fetchImpl: FetchLike, opts: Partial<CardOptions> & { chainId: number }): FetchLike {
  const key = (opts.privateKey ?? "").trim();
  if (!key) return fetchImpl;
  return async (input: string, init?: RequestInit) => {
    let header: string;
    try {
      header = await mintCardHeader({ ...opts, privateKey: key as `0x${string}` });
    } catch {
      // A key this agent cannot sign with is a configuration problem, not a
      // reason to stop buying. Proceed anonymously rather than taking the loop
      // down over a credential the request does not require.
      return fetchImpl(input, init);
    }
    const headers = new Headers(init?.headers ?? {});
    headers.set(CARD_HEADER, header);
    return fetchImpl(input, { ...(init ?? {}), headers });
  };
}
