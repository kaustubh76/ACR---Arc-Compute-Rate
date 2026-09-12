/* The terminal's card encoder, pinned to the Python gate's expectations.
 *
 * The buyer agent's identical encoder is verified against `eth_account` in
 * `tests/test_agent_card_cross_language.py`; this file pins that THIS encoder
 * produces the same wire shape, and that the demo-key derivation lands on the
 * wallet `demo_humans.py` says it should — a fact a human can check on arcscan.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_CARD_TYPES,
  CARD_HEADER,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  MAX_TTL_S,
  ZERO32,
  demoKey,
  mintCard,
  throwawayKey,
} from "./agentcard";

const CHAIN = 5042002;
const AUD = "acr-index-api";

function decode(header: string) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    card: Record<string, string | number>;
    signature: `0x${string}`;
  };
}

test("the demo key derives to the wallet demo_humans.py names", async () => {
  /* sha256("acr-buyer::acr-buyer-4") -> this address, resolved on HumanIdMirror for
     window 2958 as the solo human. If this drifts, the "as a demo human" button
     would mint a card for a wallet the chain has never heard of. */
  const { privateKeyToAccount } = await import("viem/accounts");
  const key = await demoKey("acr-buyer-4");
  assert.equal(privateKeyToAccount(key).address, "0x63C107e67527Af8aF56f427d8C5A5BDf2b2ad093");
});

test("a minted card recovers to the key that signed it", async () => {
  const { recoverTypedDataAddress } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const key = await throwawayKey();
  const minted = await mintCard({ privateKey: key, chainId: CHAIN, audience: AUD });
  const { card, signature } = decode(minted.header);
  const recovered = await recoverTypedDataAddress({
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: CHAIN },
    types: AGENT_CARD_TYPES,
    primaryType: "AgentCard",
    message: {
      agent: card.agent as `0x${string}`,
      name: card.name as string,
      role: card.role as string,
      audience: card.audience as string,
      scopeHash: card.scope_hash as `0x${string}`,
      humanCluster: card.human_cluster as `0x${string}`,
      issuedAt: BigInt(card.issued_at as number),
      expiresAt: BigInt(card.expires_at as number),
    },
    signature,
  });
  assert.equal(recovered, privateKeyToAccount(key).address);
  assert.equal(minted.agent, recovered);
});

test("the wire form is what the gate reads", async () => {
  const minted = await mintCard({ privateKey: await throwawayKey(), chainId: CHAIN, audience: AUD });
  const { card } = decode(minted.header);
  assert.deepEqual(Object.keys(card).sort(), [
    "agent", "audience", "expires_at", "human_cluster", "issued_at", "name", "role", "scope_hash",
  ]);
  // A short all-zeros hex signs identically to a real zero (EIP-712 pads it) and
  // yet reads as a human claim. 66 characters, or the Python edge refuses it.
  assert.equal((card.scope_hash as string).length, 66);
  assert.equal(card.human_cluster, ZERO32);
  assert.equal(card.role, "reader");
  assert.equal(minted.claimsHuman, false);
  assert.equal(CARD_HEADER, "AGENT-CARD");
});

test("the lifetime is clamped to the bound the gate enforces", async () => {
  const minted = await mintCard({
    privateKey: await throwawayKey(), chainId: CHAIN, audience: AUD, ttlSeconds: 30 * 86400,
  });
  const { card } = decode(minted.header);
  assert.equal((card.expires_at as number) - (card.issued_at as number), MAX_TTL_S);
});

test("a human claim is carried only when asked for, and inside the signature", async () => {
  const key = await throwawayKey();
  const CLUSTER = `0x${"ab".repeat(32)}` as const;
  const bare = await mintCard({ privateKey: key, chainId: CHAIN, audience: AUD });
  const claimed = await mintCard({ privateKey: key, chainId: CHAIN, audience: AUD, humanCluster: CLUSTER });
  assert.equal(decode(bare.header).card.human_cluster, ZERO32);
  assert.equal(decode(claimed.header).card.human_cluster, CLUSTER);
  assert.equal(claimed.claimsHuman, true);
  assert.notEqual(decode(bare.header).signature, decode(claimed.header).signature);
});
