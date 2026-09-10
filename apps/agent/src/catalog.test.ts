import assert from "node:assert/strict";
import { test } from "node:test";

import { CatalogItem, fetchCatalog, maxAdvertisedPrice, pickResources } from "./catalog.js";

const ITEMS: CatalogItem[] = [
  {
    resource: "http://api.test/prints",
    accepts: [{ amount: "100", network: "eip155:5042002" }],
    metadata: { family: "prints", provider: { name: "ACR", attestation: { sellers_attested: 2 } } },
  },
  {
    resource: "http://api.test/vol/ACR-INF",
    accepts: [{ amount: "100", network: "eip155:5042002" }],
    metadata: { family: "vol", provider: { name: "ACR", attestation: null } },
  },
  { resource: "", accepts: [] }, // malformed listing → skipped
];

test("fetchCatalog reads /marketplace/catalog items", async () => {
  const impl = async (url: string): Promise<Response> => {
    assert.ok(url.endsWith("/marketplace/catalog"));
    return new Response(JSON.stringify({ x402Version: 1, items: ITEMS }), { status: 200 });
  };
  const items = await fetchCatalog("http://api.test", impl);
  assert.equal(items.length, 3);
});

test("fetchCatalog surfaces an unavailable marketplace", async () => {
  const impl = async (): Promise<Response> => new Response("{}", { status: 503 });
  await assert.rejects(() => fetchCatalog("http://api.test", impl), /catalog unavailable/);
});

test("pickResources drops malformed listings", () => {
  assert.deepEqual(pickResources(ITEMS), [
    "http://api.test/prints",
    "http://api.test/vol/ACR-INF",
  ]);
});

test("pickResources with requireAttested keeps only attested providers", () => {
  assert.deepEqual(pickResources(ITEMS, { requireAttested: true }), ["http://api.test/prints"]);
});

test("maxAdvertisedPrice reads the dearest listing, not the first", () => {
  // The fleet prices per seller, so a flat-priced first listing says nothing
  // about the rest — this is what the spend cap is checked against.
  const mixed: CatalogItem[] = [
    { resource: "http://api.test/prints", accepts: [{ amount: "100" }] },
    { resource: "http://api.test/compute/inf-frontier", accepts: [{ amount: "5843" }] },
    { resource: "http://api.test/compute/data-small", accepts: [{ amount: "3718" }] },
  ];
  assert.equal(maxAdvertisedPrice(mixed), 0.005843);
});

test("maxAdvertisedPrice falls back to maxAmountRequired and ignores junk", () => {
  const items: CatalogItem[] = [
    { resource: "a", accepts: [{ maxAmountRequired: "250" }] },
    { resource: "b", accepts: [{ amount: "not-a-number" }] },
    { resource: "c", accepts: [] },
  ];
  assert.equal(maxAdvertisedPrice(items), 0.00025);
});

test("maxAdvertisedPrice is null when nothing carries a price", () => {
  assert.equal(maxAdvertisedPrice([{ resource: "a", accepts: [] }]), null);
});
