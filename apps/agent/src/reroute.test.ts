/* The reroute decision, pinned branch by branch — and then driven through the
 * whole buying loop with a stubbed seller, so "the signal changed a purchase" is
 * an assertion on which URL got paid, not on a log line. */

import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogItem } from "./catalog.js";
import { DEFAULTS, parseArgs } from "./config.js";
import { runAgent } from "./main.js";
import { DevPayer } from "./payer.js";
import { applyReroute, describe, fetchTca, type TcaCard } from "./reroute.js";

const API = "http://api.test";
const WORST = "0xaaaa000000000000000000000000000000000001";
const BEST = "0xbbbb000000000000000000000000000000000002";
const OTHER = "0xcccc000000000000000000000000000000000003";

function listing(label: string, payTo: string): CatalogItem {
  return {
    resource: `${API}/compute/${label}`,
    accepts: [{ amount: "100", maxAmountRequired: "100", network: "eip155:5042002", ...({ payTo } as object) }],
    metadata: { family: "compute", provider: { name: "x", attestation: {} } },
  };
}

const ITEMS = [listing("worst", WORST), listing("best", BEST), listing("other", OTHER)];
const TARGETS = ITEMS.map((i) => i.resource);

const SIGNAL: TcaCard = {
  available: true,
  benchmarked: 12,
  vw_slippage_bp: 317.4,
  // Mixed case on purpose: the tape lowercases, the catalog checksums.
  reroute: { from: WORST, to: BEST.toUpperCase().replace("0X", "0x"), saving_bp: 2893, saving_usdc: 0.003381 },
};

test("a strong signal puts the suggested seller first and drops the worst", () => {
  const { targets, decision } = applyReroute(TARGETS, ITEMS, SIGNAL);
  assert.equal(decision.kind, "reroute");
  assert.deepEqual(targets, [`${API}/compute/best`, `${API}/compute/other`]);
  assert.match(describe(decision), /reroute: 0xaaaa…0001 → 0xBBBB…0002 — past fills say 2893 bp/);
});

test("no fills yet is a hold that says the first purchases create the signal", () => {
  const { targets, decision } = applyReroute(TARGETS, ITEMS, { available: false, reason: "no settlements" });
  assert.deepEqual(targets, TARGETS);
  assert.equal(decision.kind, "hold");
  assert.match(describe(decision), /no TCA signal yet/);
});

test("a saving under the threshold is a hold, and the threshold is the caller's", () => {
  const weak = { ...SIGNAL, reroute: { ...SIGNAL.reroute!, saving_bp: 12 } };
  assert.equal(applyReroute(TARGETS, ITEMS, weak).decision.kind, "hold");
  assert.equal(applyReroute(TARGETS, ITEMS, weak, { minBp: 10 }).decision.kind, "reroute");
});

test("a suggested seller the catalog no longer lists leaves the targets untouched", () => {
  const gone = { ...SIGNAL, reroute: { ...SIGNAL.reroute!, to: "0xdddd000000000000000000000000000000000004" } };
  const { targets, decision } = applyReroute(TARGETS, ITEMS, gone);
  assert.deepEqual(targets, TARGETS);
  assert.equal(decision.kind, "hold");
  assert.match(describe(decision), /no listing in this catalog/);
});

test("fetchTca never throws: a dead press is a hold, not a crashed buyer", async () => {
  const card = await fetchTca(API, "0xpayer", async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal(card.available, false);
  assert.match(card.reason ?? "", /ECONNREFUSED/);
});

test("--reroute without --discover is refused before any money moves", () => {
  assert.throws(() => parseArgs(["--reroute"]), /needs --discover/);
  const cfg = parseArgs(["--discover", "--reroute", "--reroute-min-bp", "50"]);
  assert.equal(cfg.reroute, true);
  assert.equal(cfg.rerouteMinBp, 50);
});

test("through the loop: the first payment lands on the suggested seller and none on the worst", async () => {
  const paid: string[] = [];
  let settles = 0;
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (url.endsWith("/marketplace/catalog")) return new Response(JSON.stringify({ items: ITEMS }), { status: 200 });
    if (url.includes("/tca/")) return new Response(JSON.stringify(SIGNAL), { status: 200 });
    if (!headers.has("PAYMENT-SIGNATURE")) {
      return new Response(JSON.stringify({ accepts: [{ amount: "100", maxAmountRequired: "100" }] }), {
        status: 402,
        headers: { "X-402-Price": "0.0001" },
      });
    }
    settles += 1;
    paid.push(url);
    const conf = Buffer.from(JSON.stringify({ success: true, transaction: `dev-${settles}`, network: "eip155:1", payer: "0xagent" })).toString("base64");
    return new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": conf } });
  };
  const results = await runAgent(
    { ...DEFAULTS, api: API, count: 4, discover: true, reroute: true, delayMs: 0 },
    { payer: new DevPayer("0xagent", impl), fetchImpl: impl, log: () => {} },
  );
  assert.equal(results.length, 4);
  assert.equal(paid[0], `${API}/compute/best`);
  assert.ok(paid.every((u) => !u.endsWith("/compute/worst")), "the worst seller must get nothing this run");
  assert.deepEqual(new Set(paid), new Set([`${API}/compute/best`, `${API}/compute/other`]));
});
