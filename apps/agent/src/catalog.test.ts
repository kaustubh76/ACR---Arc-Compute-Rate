import assert from "node:assert/strict";
import { test } from "node:test";

import { CatalogItem, fetchCatalog, pickResources } from "./catalog.js";

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
