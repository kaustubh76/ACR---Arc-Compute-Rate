/* The card this agent mints — shape, bounds, and the fetch wrapper.
 *
 * The cross-language half lives in `tests/test_agent_card_cross_language.py`,
 * which verifies a card minted HERE against the Python gate's recovery path. That
 * is the assertion that matters and it cannot live in this file; what this file
 * covers is everything that is true before the signature leaves the process.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CARD_HEADER, MAX_TTL_S, mintCardHeader, withCard } from "./card.js";

const KEY = `0x${"11".repeat(32)}` as const;
const CHAIN = 5042002;
const ZERO32 = `0x${"00".repeat(32)}` as const;

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

function decode(header: string) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    card: Record<string, string | number>;
    signature: `0x${string}`;
  };
}

test("the signature recovers to the key that signed it", async () => {
  const header = await mintCardHeader({ privateKey: KEY, chainId: CHAIN });
  const { card, signature } = decode(header);
  const recovered = await recoverTypedDataAddress({
    domain: { name: "ACR Agent Card", version: "1", chainId: CHAIN },
    types: TYPES,
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
  assert.equal(recovered, privateKeyToAccount(KEY).address);
});

test("the bytes32 fields are a full 32 bytes", async () => {
  /* A short all-zeros hex signs identically to a real zero, because EIP-712 pads
     it — so an encoder that emitted "0x0" would verify AND be read as claiming a
     human. The Python side now refuses that at the edge; this is the other half. */
  const { card } = decode(await mintCardHeader({ privateKey: KEY, chainId: CHAIN }));
  assert.equal((card.scope_hash as string).length, 66);
  assert.equal((card.human_cluster as string).length, 66);
  assert.equal(card.human_cluster, ZERO32);
});

test("the lifetime is clamped to the bound the gate enforces", async () => {
  const { card } = decode(
    await mintCardHeader({ privateKey: KEY, chainId: CHAIN, ttlSeconds: 30 * 86400 }),
  );
  const ttl = (card.expires_at as number) - (card.issued_at as number);
  assert.equal(ttl, MAX_TTL_S, "a 30-day card must be clamped, not minted and refused");
});

test("a card names the audience it is for", async () => {
  /* The domain has no verifyingContract, so the audience is the only thing
     stopping a card minted for us being presented somewhere else. */
  const { card } = decode(
    await mintCardHeader({ privateKey: KEY, chainId: CHAIN, audience: "somewhere-else" }),
  );
  assert.equal(card.audience, "somewhere-else");
});

test("withCard attaches the header to every request", async () => {
  const seen: string[] = [];
  const spy = async (_url: string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers ?? {}).get(CARD_HEADER) ?? "");
    return new Response("{}", { status: 200 });
  };
  const wrapped = withCard(spy, { privateKey: KEY, chainId: CHAIN });
  await wrapped("https://example.test/a");
  await wrapped("https://example.test/b");
  assert.equal(seen.length, 2);
  assert.ok(seen.every((h) => h.length > 0), "both requests must carry a card");
});

test("withCard preserves headers the caller already set", async () => {
  let got = new Headers();
  const spy = async (_url: string, init?: RequestInit) => {
    got = new Headers(init?.headers ?? {});
    return new Response("{}", { status: 200 });
  };
  await withCard(spy, { privateKey: KEY, chainId: CHAIN })("https://example.test", {
    headers: { "PAYMENT-SIGNATURE": "x402 0xabc:100" },
  });
  assert.equal(got.get("PAYMENT-SIGNATURE"), "x402 0xabc:100");
  assert.ok((got.get(CARD_HEADER) ?? "").length > 0);
});

test("with no key the fetch is returned untouched", async () => {
  /* An agent with no card is served anonymously, which is a working state. The
     identity check is strict equality: a wrapper that merely skipped the header
     would still have replaced the function, and the point is that it does not. */
  const spy = async () => new Response("{}", { status: 200 });
  assert.equal(withCard(spy, { privateKey: "" as `0x${string}`, chainId: CHAIN }), spy);
  assert.equal(withCard(spy, { chainId: CHAIN }), spy);
});

test("a key that cannot sign does not take the buying loop down", async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  const wrapped = withCard(spy, { privateKey: "0xnot-a-key" as `0x${string}`, chainId: CHAIN });
  const res = await wrapped("https://example.test");
  assert.equal(res.status, 200);
  assert.ok(called, "the request must still go out, just without a card");
});
