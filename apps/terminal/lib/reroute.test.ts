/* The ported decision, pinned to the same cases apps/agent/src/reroute.test.ts pins —
 * so what /loop shows a visitor is what the agent does. */
import assert from "node:assert/strict";
import test from "node:test";
import { applyReroute, describe } from "./reroute";

const API = "https://acr.test";
const WORST = "0xaaaa000000000000000000000000000000000001";
const BEST = "0xbbbb000000000000000000000000000000000002";
const OTHER = "0xcccc000000000000000000000000000000000003";
const listing = (label: string, payTo: string) => ({ resource: `${API}/compute/${label}`, accepts: [{ payTo }] });
const ITEMS = [listing("worst", WORST), listing("best", BEST), listing("other", OTHER)];
const TARGETS = ITEMS.map((i) => i.resource);
const SIGNAL = { available: true, reroute: { from: WORST, to: BEST.toUpperCase().replace("0X", "0x"), saving_bp: 2893, saving_usdc: 0.003381 } };

test("a strong signal puts the suggested seller first and drops the worst", () => {
  const { targets, decision } = applyReroute(TARGETS, ITEMS, SIGNAL);
  assert.equal(decision.kind, "reroute");
  assert.deepEqual(targets, [`${API}/compute/best`, `${API}/compute/other`]);
  assert.match(describe(decision), /reroute: 0xaaaa…0001 → 0xBBBB…0002 — past fills say 2893 bp .* next payment goes to \/compute\/best/);
});

test("the threshold is the caller's: the same signal holds above it and reroutes below it", () => {
  const weak = { ...SIGNAL, reroute: { ...SIGNAL.reroute, saving_bp: 12 } };
  assert.equal(applyReroute(TARGETS, ITEMS, weak).decision.kind, "hold");
  assert.equal(applyReroute(TARGETS, ITEMS, weak, { minBp: 10 }).decision.kind, "reroute");
  assert.equal(applyReroute(TARGETS, ITEMS, SIGNAL, { minBp: 3000 }).decision.kind, "hold");
});

test("no signal, no second seller, or an unlisted seller are holds that say why", () => {
  assert.match(describe(applyReroute(TARGETS, ITEMS, { available: false, reason: "no settlements" }).decision), /no TCA signal yet/);
  assert.match(describe(applyReroute(TARGETS, ITEMS, { available: true, reroute: null }).decision), /fewer than two/);
  const gone = { ...SIGNAL, reroute: { ...SIGNAL.reroute, to: "0xdddd000000000000000000000000000000000004" } };
  assert.match(describe(applyReroute(TARGETS, ITEMS, gone).decision), /no listing in this catalog/);
});
