/* Which business /spend opens on (lib/spendBusiness.ts). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultBusiness } from "./spendBusiness";

const rows = [
  { slug: "acr-fleet", chain: "testnet" },
  { slug: "sandbox", chain: "testnet" },
  { slug: "acr-operator", chain: "testnet" },
  { slug: "acr-mainnet", chain: "mainnet" },
];

test("a mainnet reader opens on a mainnet business", () => {
  // Measured 2026-10-16: the mainnet /spend opened on testnet acr-fleet, because
  // the registry lists every chain's businesses and the page took the first row.
  assert.equal(defaultBusiness(rows, "mainnet"), "acr-mainnet");
});

test("a testnet reader still opens where it always did", () => {
  assert.equal(defaultBusiness(rows, "testnet"), "acr-fleet");
});

test("with nothing on this chain, the first row is still better than an empty page", () => {
  assert.equal(defaultBusiness(rows.slice(0, 3), "mainnet"), "acr-fleet");
  assert.equal(defaultBusiness([], "mainnet"), null);
});

test("the spend page asks it, with the request's chain", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "app", "spend", "view.tsx"), "utf8");
  assert.match(src, /defaultBusiness\(rows, chain\)/);
  assert.doesNotMatch(src, /\?\? rows\[0\]\?\.slug/, "the chain-blind default is back");
});
