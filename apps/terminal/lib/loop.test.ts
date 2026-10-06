import assert from "node:assert/strict";
import test from "node:test";
import { LOOP_NODES, logFrac } from "./loop";

test("the log scale clamps and ignores non-positive values", () => {
  assert.equal(logFrac(1, 1, 100), 0);
  assert.equal(logFrac(100, 1, 100), 1);
  assert.ok(Math.abs(logFrac(10, 1, 100) - 0.5) < 1e-9);
  assert.equal(logFrac(0, 1, 100), 0);
  assert.equal(logFrac(1e9, 1, 100), 1);
  assert.equal(LOOP_NODES.length, 6);
});
