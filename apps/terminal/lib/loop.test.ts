import assert from "node:assert/strict";
import test from "node:test";
import { RATING_WINDOW_S } from "./humans";
import { LOOP_NODES, boundMultiple, logFrac, windowEndsInS } from "./loop";

test("the window ends on the boundary, never in the past", () => {
  const w = 2958;
  const start = w * RATING_WINDOW_S;
  assert.equal(windowEndsInS(start), RATING_WINDOW_S);
  assert.equal(windowEndsInS(start + RATING_WINDOW_S - 1), 1);
});

test("the multiple is null whenever a side is missing or zero, because 0 means not computed", () => {
  assert.equal(boundMultiple(10, 0.02), 500);
  assert.equal(boundMultiple(0, 0.02), null);
  assert.equal(boundMultiple(10, 0), null);
  assert.equal(boundMultiple(null, 1), null);
});

test("the log scale clamps and ignores non-positive values", () => {
  assert.equal(logFrac(1, 1, 100), 0);
  assert.equal(logFrac(100, 1, 100), 1);
  assert.ok(Math.abs(logFrac(10, 1, 100) - 0.5) < 1e-9);
  assert.equal(logFrac(0, 1, 100), 0);
  assert.equal(logFrac(1e9, 1, 100), 1);
  assert.equal(LOOP_NODES.length, 6);
});
