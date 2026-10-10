import { test } from "node:test";
import assert from "node:assert/strict";

import { CHAIN_COOKIE, CHAIN_PARAM, DEFAULT_CHAIN } from "./chainChoice";
import { chainHeaders, cookieValue, envelope, refusalHeaders, requestChain } from "./envelope";

const req = (url: string, cookie?: string): Request =>
  new Request(url, cookie ? { headers: { cookie } } : undefined);

test("the chain param outranks the cookie, and the cookie outranks nothing", () => {
  // The param must win. A URL carrying chain=testnet can be answered from a
  // shared cache, so it must never be served from the rig this particular
  // visitor's cookie names.
  assert.equal(requestChain(req(`https://a.test/api/x?${CHAIN_PARAM}=testnet`)), "testnet");
  assert.equal(
    requestChain(req(`https://a.test/api/x?${CHAIN_PARAM}=mainnet`, `${CHAIN_COOKIE}=testnet`)),
    "mainnet",
  );
  assert.equal(requestChain(req("https://a.test/api/x", `${CHAIN_COOKIE}=testnet`)), "testnet");
  assert.equal(requestChain(req("https://a.test/api/x")), DEFAULT_CHAIN);
});

test("junk in either carrier falls through rather than throwing", () => {
  // A stray param is a visitor's mistake, not an outage. It must degrade to the
  // cookie and then to the default, never 500 a data route.
  assert.equal(
    requestChain(req(`https://a.test/api/x?${CHAIN_PARAM}=arc`, `${CHAIN_COOKIE}=testnet`)),
    "testnet",
  );
  assert.equal(requestChain(req(`https://a.test/api/x?${CHAIN_PARAM}=arc`)), DEFAULT_CHAIN);
  assert.equal(requestChain(req("https://a.test/api/x", `${CHAIN_COOKIE}=nonsense`)), DEFAULT_CHAIN);
});

test("the cookie is found among others, and its value may contain an equals sign", () => {
  const header = `theme=dark; ${CHAIN_COOKIE}=testnet; other=a=b`;
  assert.equal(cookieValue(header, CHAIN_COOKIE), "testnet");
  assert.equal(cookieValue(header, "other"), "a=b", "split on the FIRST equals only");
  assert.equal(cookieValue(header, "absent"), null);
  assert.equal(cookieValue(null, CHAIN_COOKIE), null);
  // A prefix must not match: `acr-chain-other` is not `acr-chain`.
  assert.equal(cookieValue(`${CHAIN_COOKIE}-other=x`, CHAIN_COOKIE), null);
  // Whitespace around the name and the value is the header's own grammar.
  assert.equal(cookieValue(`  ${CHAIN_COOKIE} = testnet `, CHAIN_COOKIE), "testnet");
});

test("every envelope says which chain answered", () => {
  // The builder demands the chain so an unstamped response cannot be shipped:
  // the client treats an absent stamp as a mismatch and refuses to render it.
  const e = envelope({ n: 1 }, { live: true, chain: "testnet" });
  assert.equal(e.chain, "testnet");
  assert.equal(e.live, true);
  assert.deepEqual(e.data, { n: 1 });
  assert.ok(e.fetchedAt > 0);
  assert.equal("upstream" in e, false, "an absent upstream stays absent, not undefined");

  const withUpstream = envelope(null, { live: false, chain: "mainnet", upstream: "timeout" });
  assert.equal(withUpstream.upstream, "timeout");
  assert.equal(withUpstream.chain, "mainnet");
});

test("a shared directive survives on the default chain and nowhere else", () => {
  const PUB = "public, s-maxage=5, stale-while-revalidate=30";
  assert.equal(chainHeaders(PUB, "mainnet")["Cache-Control"], PUB, "today's caching must not move");
  assert.equal(chainHeaders(PUB, "testnet")["Cache-Control"], "private, no-store");
  assert.equal(chainHeaders(PUB, DEFAULT_CHAIN)["Cache-Control"], PUB);
});

test("a refusal is never cached, on any chain", () => {
  // One failed read served from the CDN for ten seconds is a shared, confident
  // lie, and the retry that would fix it never reaches the origin.
  assert.equal(refusalHeaders()["Cache-Control"], "no-store");
});
