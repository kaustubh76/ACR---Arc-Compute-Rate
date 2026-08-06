import { test } from "node:test";
import assert from "node:assert/strict";
import { fmt, fmtPrice } from "./format";

/* The bug this file exists for.

   `/curve`'s quote corridor drew ACR-DATA's mid and ask as the same string,
   "0.00210", so its three-number corridor read as two. The prices were right;
   five FIXED decimal places is five significant figures at ACR-INF's level
   (~0.49) and two at ACR-DATA's (~0.0021), and a 50bp spread on 0.0021 is
   ±5.3e-6 — under the 1e-5 quantum. These are the real bundle values. */

const INF = { bid: 0.4877778141953168, mid: 0.4890096381339856, ask: 0.49024146207265445 };
const GPU = { bid: 0.011174380289551509, mid: 0.011202405275673752, ask: 0.011230430261795994 };
const DATA = { bid: 0.00209425568632808, mid: 0.0020995458859619474, ask: 0.002104836085595815 };

test("the collision this replaces is real, so the fix is not theoretical", () => {
  // Pin the old behaviour so nobody "simplifies" fmtPrice back to fmt.
  assert.equal(fmt(DATA.mid), fmt(DATA.ask));
  assert.equal(fmt(DATA.mid), "0.00210");
});

test("a corridor's three prices stay three distinct numbers, at every index level", () => {
  for (const [name, q] of Object.entries({ INF, GPU, DATA })) {
    const shown = [q.bid, q.mid, q.ask].map((v) => fmtPrice(v));
    assert.equal(new Set(shown).size, 3, `${name}: ${shown.join(" / ")}`);
  }
});

test("ACR-INF is byte-identical to the old formatter", () => {
  // The compatibility promise: nothing already published, snapshotted or
  // quoted in the docs moves. log10(0.49) floors to -1, so dp lands on 5.
  for (const v of [INF.bid, INF.mid, INF.ask]) assert.equal(fmtPrice(v), fmt(v));
});

test("the smaller indices gain exactly the digits they were missing", () => {
  assert.equal(fmtPrice(GPU.mid), "0.011202");
  assert.equal(fmtPrice(DATA.mid), "0.0020995");
  assert.equal(fmtPrice(DATA.ask), "0.0021048");
});

test("every index gets the same number of significant figures", () => {
  // The invariant the fixed-decimal formatter violated: resolution should not
  // depend on the unit an index happens to be quoted in.
  const sigFigs = (s: string) => s.replace("0.", "").replace(/^0+/, "").length;
  assert.deepEqual([INF.mid, GPU.mid, DATA.mid].map((v) => sigFigs(fmtPrice(v))), [5, 5, 5]);
});

test("a non-number is an em dash, not the string NaN", () => {
  for (const bad of [NaN, Infinity, -Infinity]) assert.equal(fmtPrice(bad), "—");
});

test("zero does not poison the magnitude clamp", () => {
  // log10(0) is -Infinity; without the guard the decimal count would be too.
  assert.equal(fmtPrice(0), fmt(0));
});

test("a negative price is formatted on its magnitude, not rejected", () => {
  assert.equal(fmtPrice(-0.0020995458859619474), "-0.0020995");
});

test("decimals stay inside the clamp for absurd magnitudes", () => {
  assert.equal(fmtPrice(123456), "123,456.00"); // floor at 2dp
  assert.ok(fmtPrice(1e-12).length < 20); // ceiling at 9dp, not 13
});
