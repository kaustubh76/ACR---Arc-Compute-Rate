import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWED, ROTATION, chooseTargets, clampCount, withinCap } from "./buyPlan";

test("clampCount bounds to [1,5] and defaults non-finite to 3", () => {
  assert.equal(clampCount(3), 3);
  assert.equal(clampCount(0), 1); // floor of the range
  assert.equal(clampCount(-4), 1);
  assert.equal(clampCount(99), 5); // ceiling — real money, low cap
  assert.equal(clampCount(2.9), 2); // floored
  assert.equal(clampCount(NaN), 3);
  assert.equal(clampCount(undefined), 3);
  assert.equal(clampCount("4" as unknown), 3); // non-number → default
});

test("chooseTargets: empty paths never yields an empty list (the /undefined bug)", () => {
  const t = chooseTargets([], 3);
  assert.equal(t.length, 3);
  assert.ok(t.every((p) => ROTATION.includes(p)));
  assert.ok(!t.includes(undefined as unknown as string));
});

test("chooseTargets: null/undefined paths → rotation", () => {
  assert.deepEqual(chooseTargets(null, 2), ROTATION.slice(0, 2));
  assert.deepEqual(chooseTargets(undefined, 5), ROTATION.slice(0, 5));
});

test("chooseTargets: any disallowed entry → falls back to rotation (SSRF guard)", () => {
  const t = chooseTargets(["/prints/ACR-INF", "/etc/passwd"], 2);
  assert.deepEqual(t, ROTATION.slice(0, 2));
  assert.ok(!t.includes("/etc/passwd"));
});

test("chooseTargets: an external URL is never honored", () => {
  const t = chooseTargets(["https://evil.example/steal"], 3);
  assert.ok(t.every((p) => ALLOWED.has(p)));
});

test("chooseTargets: fully-allowlisted non-empty paths are honored, sliced to count", () => {
  const t = chooseTargets(["/prints", "/curve/ACR-GPU", "/vol/ACR-DATA"], 2);
  assert.deepEqual(t, ["/prints", "/curve/ACR-GPU"]);
});

test("chooseTargets: result is always allowlisted regardless of input", () => {
  for (const input of [null, [], ["/x"], ["/prints", "/nope"]]) {
    for (const p of chooseTargets(input as string[] | null, 5)) {
      assert.ok(ALLOWED.has(p), `unexpected target ${p}`);
    }
  }
});

test("withinCap refuses the payment that would breach the cap", () => {
  assert.equal(withinCap(0, 0.0001, 0.01), true);
  assert.equal(withinCap(0.0099, 0.0001, 0.01), true); // lands exactly on cap
  assert.equal(withinCap(0.01, 0.0001, 0.01), false); // already at cap → refuse next
  assert.equal(withinCap(0.008, 0.003, 0.01), false); // 0.011 > 0.01
});
