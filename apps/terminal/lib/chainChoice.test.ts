import { test } from "node:test";
import assert from "node:assert/strict";

import { MAINNET_SELLER, TESTNET_SELLER } from "./apiBase";
import { CHAIN, CHAIN_TESTNET, chainFacts, isMainnet } from "./chain";
import {
  apiKey,
  CHAIN_KEYS,
  CHAIN_PARAM,
  CHAINS,
  DEFAULT_CHAIN,
  chainCandidates,
  emptyChainFacts,
  emptyTerminal,
  parseChainKey,
  resolveChain,
  sameChain,
} from "./chainChoice";
import { readHeaders, sharedCache } from "./readResult";
import { ok, unread } from "./readResult";

test("the default chain is mainnet, and the registry agrees with the profiles", () => {
  // The product is mainnet; testnet is a partner detour. A visitor who has
  // never chosen must land on the product.
  assert.equal(DEFAULT_CHAIN, "mainnet");
  assert.deepEqual(CHAIN_KEYS, ["mainnet", "testnet"]);
  assert.equal(CHAINS.mainnet.chainId, CHAIN.chainId);
  assert.equal(CHAINS.testnet.chainId, CHAIN_TESTNET.chainId);
  assert.equal(CHAINS.mainnet.published, MAINNET_SELLER);
  assert.equal(CHAINS.testnet.published, TESTNET_SELLER);
  // No chain id is retyped in chainChoice.ts — they come from the profiles, so
  // the two cannot drift apart.
  assert.notEqual(CHAINS.mainnet.chainId, CHAINS.testnet.chainId);
});

test("only mainnet carries the bundle and the direct-chain reads", () => {
  // Both flags are single-chain by construction, not by omission. fallback.json
  // is a mainnet snapshot that mainnetOnly.test.ts pins field by field, and the
  // three direct readers take their contract addresses from it.
  assert.equal(CHAINS.mainnet.bundle, true);
  assert.equal(CHAINS.testnet.bundle, false);
  assert.equal(CHAINS.mainnet.directReads, true);
  assert.equal(CHAINS.testnet.directReads, false);
});

test("an unrecognised chain is null, never a quiet default", () => {
  assert.equal(parseChainKey("mainnet"), "mainnet");
  assert.equal(parseChainKey("TESTNET"), "testnet");
  assert.equal(parseChainKey(" testnet "), "testnet");
  for (const junk of ["", "arc", "5042", null, undefined, 5042, {}, []]) {
    assert.equal(parseChainKey(junk), null, `${JSON.stringify(junk)} is not a chain`);
  }
});

test("an explicit param outranks the cookie, and both outrank nothing", () => {
  // The param has to win: a URL carrying chain=testnet may be answered from a
  // cache, so it must never be served from the rig this visitor's cookie names.
  assert.equal(resolveChain("testnet", "mainnet"), "testnet");
  assert.equal(resolveChain("mainnet", "testnet"), "mainnet");
  assert.equal(resolveChain(null, "testnet"), "testnet");
  assert.equal(resolveChain("junk", "testnet"), "testnet", "junk falls through to the cookie");
  assert.equal(resolveChain(null, null), DEFAULT_CHAIN);
  assert.equal(resolveChain("junk", "junk"), DEFAULT_CHAIN);
});

test("apiKey stamps the chain on EVERY chain, default included", () => {
  // Stamping only the non-default would leave the default's entries at the bare
  // URL, where a response cached before this param existed can still answer
  // them. One shape for both chains has no such seam.
  assert.equal(apiKey("/api/terminal", "mainnet"), `/api/terminal?${CHAIN_PARAM}=mainnet`);
  assert.equal(apiKey("/api/terminal", "testnet"), `/api/terminal?${CHAIN_PARAM}=testnet`);
  for (const key of CHAIN_KEYS) {
    assert.match(apiKey("/api/tape", key), new RegExp(`[?&]${CHAIN_PARAM}=${key}$`));
  }
});

test("apiKey keeps an existing query and never duplicates the param", () => {
  const once = apiKey("/api/par?unit=x&billed_usdc=1", "testnet");
  const twice = apiKey(once, "testnet");
  assert.equal(twice, once, "re-keying an already-keyed path is a no-op");
  const p = new URLSearchParams(once.split("?")[1]);
  assert.equal(p.getAll(CHAIN_PARAM).length, 1);
  assert.equal(p.get("unit"), "x");
  assert.equal(p.get("billed_usdc"), "1");
  // Re-keying to the OTHER chain must replace, not append.
  const flipped = new URLSearchParams(apiKey(once, "mainnet").split("?")[1]);
  assert.deepEqual(flipped.getAll(CHAIN_PARAM), ["mainnet"]);
});

test("the candidate ladder dedupes, and the override comes first", () => {
  assert.deepEqual(chainCandidates("mainnet", "", "production"), [MAINNET_SELLER]);
  assert.deepEqual(chainCandidates("testnet", "", "production"), [TESTNET_SELLER]);
  assert.deepEqual(chainCandidates("mainnet", "https://other.test", "production"), [
    "https://other.test",
    MAINNET_SELLER,
  ]);
  // An override equal to the published host is ONE candidate: deriving the
  // cushion from the same variable once collapsed the list to a single dead
  // host, so the fallback could never fire.
  assert.deepEqual(chainCandidates("mainnet", MAINNET_SELLER, "production"), [MAINNET_SELLER]);
  assert.deepEqual(chainCandidates("mainnet", `${MAINNET_SELLER}/`, "production"), [MAINNET_SELLER]);
});

test("an empty payload still says WHICH chain it is empty for", () => {
  // chainFacts(undefined) falls back to the mainnet profile field by field, so
  // an empty payload would print "Arc mainnet" over a testnet session. This is
  // the assertion that forecloses it.
  for (const key of CHAIN_KEYS) {
    const facts = chainFacts(emptyTerminal(key).chain);
    assert.equal(
      isMainnet(facts),
      key === "mainnet",
      `${key}: isMainnet must follow the chain, not the fallback`,
    );
    assert.equal(facts.chainId, CHAINS[key].chainId);
  }
  assert.notEqual(
    chainFacts(emptyTerminal("testnet").chain).explorer,
    CHAIN.explorer,
    "a testnet session must not link to the mainnet explorer",
  );
});

test("an empty chain block names no contract it does not know", () => {
  // Omitting is honest; printing a mainnet address under a testnet heading is
  // the same lie by another route. deployedContracts() drops null rows.
  const t = emptyChainFacts("testnet") as unknown as Record<string, unknown>;
  for (const k of ["oracle_address", "registry_address", "futures_address"]) {
    assert.equal(t[k], null, `${k} must be null, not a mainnet address`);
  }
  assert.equal(t.chain_id, CHAIN_TESTNET.chainId);
  assert.equal(t.gateway_wallet, CHAIN_TESTNET.gatewayWallet, "the wallet a payment actually pays");
});

test("sameChain is the guard that survives a cache, so absence is a mismatch", () => {
  assert.equal(sameChain({ chain: "testnet" }, "testnet"), true);
  assert.equal(sameChain({ chain: "mainnet" }, "testnet"), false);
  // An envelope with no stamp is NOT the default: "I don't know which chain
  // this is" must not render as mainnet.
  assert.equal(sameChain({}, "mainnet"), false);
  assert.equal(sameChain(null, "mainnet"), false);
  assert.equal(sameChain("mainnet", "mainnet"), false);
});

test("sharedCache keeps the shared directive only for the default chain", () => {
  const PUB = "public, s-maxage=10, stale-while-revalidate=30";
  assert.equal(sharedCache(PUB, "mainnet"), PUB);
  assert.equal(sharedCache(PUB), PUB, "omitted means the default, as before there was a choice");
  assert.equal(sharedCache(PUB, ""), PUB);
  assert.equal(sharedCache(PUB, "testnet"), "private, no-store");
  // The constant this module spells locally must match the real default.
  assert.equal(sharedCache(PUB, DEFAULT_CHAIN), PUB);
});

test("a failed read is never cached, on either chain", () => {
  // The original bug: one throttled answer served from the CDN for ten seconds
  // turns a blip into a shared, confident lie.
  for (const chain of [undefined, "mainnet", "testnet"]) {
    const headers = readHeaders(unread("throttled"));
    assert.equal(headers["Cache-Control"], "no-store", `chain=${chain}`);
  }
  assert.match(readHeaders(ok(1))["Cache-Control"], /public, s-maxage/);
});

test("the cushion is shaped like the payload it stands in for", () => {
  /* IT WAS NOT, AND A CAST HID IT. `emptyTerminal` built
     `attack: {runs, summary}` behind an `as unknown as TerminalData`, while
     the type says `{per_index, series, usdc_burned, n_adversarial}` — so
     `app/attack/view.tsx` read `.series.length` off undefined and threw during
     the server render. Testnet has `bundle: false`, so this object IS what a
     visitor gets while the press wakes.

     The cast is gone, so `tsc` now enforces this. The test states the shape
     anyway, because the next person to reach for a cast here should have to
     delete an assertion that says why there isn't one. */
  for (const chain of ["mainnet", "testnet"] as const) {
    const t = emptyTerminal(chain);
    assert.ok(Array.isArray(t.attack.series), "series must be an array to be measured");
    assert.ok(Array.isArray(t.attack.per_index));
    assert.equal(t.attack.series.length, 0, "empty, not absent");
    assert.equal(t.attack.usdc_burned, 0);
    assert.equal(t.attack.n_adversarial, 0);
  }
});
