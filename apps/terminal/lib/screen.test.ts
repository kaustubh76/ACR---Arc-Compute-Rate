import assert from "node:assert/strict";
import test from "node:test";
import { INJECTION, matchedFilters, verdictOf } from "./screen";

test("five verdicts, and a 200 is only a pass when the screen actually looked", () => {
  assert.equal(verdictOf(403, 1), "blocked");
  assert.equal(verdictOf(502, 2), "reply_blocked");
  assert.equal(verdictOf(200, 2), "passed");
  assert.equal(verdictOf(200, 0), "unscreened");
  assert.equal(verdictOf(200, null), "unscreened");
  assert.equal(verdictOf(503, 0), "unavailable");
  assert.equal(verdictOf(null, null), "unavailable");
});

test("the filter names come out of the 403 body and nothing else does", () => {
  assert.deepEqual(matchedFilters({ detail: { matched: ["pi_and_jailbreak"], direction: "request" } }), ["pi_and_jailbreak"]);
  assert.deepEqual(matchedFilters({ detail: "malformed" }), []);
  assert.deepEqual(matchedFilters(null), []);
  assert.ok(!INJECTION.includes("\n"), "one line, the plainest attempt");
});
