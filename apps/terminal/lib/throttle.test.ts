import assert from "node:assert/strict";
import test from "node:test";
import { Throttle, callerKey } from "./throttle";

test("a caller gets the per-key allowance, then a 429 with a retry time, then the window slides", () => {
  const t = new Throttle({ perKey: 3, global: 100, windowMs: 60_000 });
  const t0 = 1_000_000;
  assert.equal(t.allow("a", t0).ok, true);
  assert.equal(t.allow("a", t0 + 1).ok, true);
  assert.equal(t.allow("a", t0 + 2).ok, true);
  const r = t.allow("a", t0 + 3);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "caller");
    assert.equal(r.retryInS, 60);
  }
  assert.equal(t.allow("b", t0 + 4).ok, true, "another caller is unaffected");
  assert.equal(t.allow("a", t0 + 60_001).ok, true, "the window slid");
});

test("the global allowance protects the shared card from many callers at once", () => {
  const t = new Throttle({ perKey: 10, global: 4, windowMs: 60_000 });
  for (let i = 0; i < 4; i++) assert.equal(t.allow(`c${i}`, 1000 + i).ok, true);
  const r = t.allow("c9", 1010);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "everyone");
});

test("the caller key is the right-most forwarded hop, the one the platform appended", () => {
  const h = (m: Record<string, string>) => ({ get: (k: string) => m[k.toLowerCase()] ?? null });
  assert.equal(callerKey(h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" })), "3.3.3.3");
  assert.equal(callerKey(h({ "x-real-ip": "9.9.9.9" })), "9.9.9.9");
  assert.equal(callerKey(h({})), "local");
});
