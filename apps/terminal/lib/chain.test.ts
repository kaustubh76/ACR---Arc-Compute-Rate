import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_SETTLE_AGE_S } from "./chain";

test("the freshness window matches the contract it copies", () => {
  // A constant that is right when typed is the shape of the `multiplier` bug:
  // that number was correct too, in an example, in a comment — and the terminal
  // stated it as fact for a series that used a different one. Bind the copy to
  // its source so a redeploy cannot silently make the badge wrong.
  const sol = readFileSync(
    join(__dirname, "..", "..", "..", "contracts", "src", "ACRFutures.sol"),
    "utf8",
  );
  const m = sol.match(/MAX_SETTLE_AGE\s*=\s*(\d+)/);
  assert.ok(m, "ACRFutures.sol should declare MAX_SETTLE_AGE");
  assert.equal(
    MAX_SETTLE_AGE_S,
    Number(m![1]),
    "lib/chain.ts MAX_SETTLE_AGE_S has drifted from ACRFutures.sol",
  );
});
