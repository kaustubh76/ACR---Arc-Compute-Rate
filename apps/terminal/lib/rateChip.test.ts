import { test } from "node:test";
import assert from "node:assert/strict";

import { rateChip } from "./rateChip";

/* Whose prices answered, and whether the chip says so.
 *
 * THE DATED ONE. `/par` falls back to the FLEET's own quotes whenever the
 * market basket is unusable or stale. `anchors/GAP.md` records that scale at
 * 20x to 1250x off real market prices — so a confident "over the rate" on a
 * real invoice, measured against ourselves, is the one number on this site
 * that a reviewer could open a file in the repo and disprove.
 *
 * The baskets are dated 2026-10-06, `ANCHOR_MAX_AGE_S` is thirty days, and
 * `scripts/anchors.py --fetch` is manual and in no CI. So around 2026-11-05
 * every answer flips to the fleet by itself, with nothing failing and nobody
 * watching. This test is what notices.
 */

test("a market comparison keeps its confident verdict", () => {
  assert.equal(rateChip(900, "market", "ok").x, "over the rate");
  assert.equal(rateChip(-900, "market", "ok").x, "under the rate");
  assert.equal(rateChip(0, "market", "ok").x, "at the rate");
});

test("a fleet comparison never wears the market's chip", () => {
  for (const bp of [900, -900, 0]) {
    const chip = rateChip(bp, "fleet", "ok");
    assert.match(chip.x, /our prices/, `fleet at ${bp}bp must say whose prices answered`);
    assert.equal(chip.cls, "chip muted", "and must not wear a confident colour");
    assert.doesNotMatch(chip.x, /over the rate|under the rate|at the rate/);
  }
});

test("a stale basket says that is why", () => {
  /* STALE is the state the clock produces on its own. Naming it separates
     "we have no market data for this unit" from "we had some and it expired",
     which are different things to go and fix. */
  assert.match(rateChip(900, "fleet", "STALE").x, /stale/);
});

test("no benchmark at all is still its own state", () => {
  assert.equal(rateChip(null, "market", "ok").x, "no benchmark");
  assert.equal(rateChip(null, "fleet", "STALE").x, "no benchmark", "absent outranks whose prices");
});

test("an unknown comparison is treated as not-the-market", () => {
  // Fail toward the caveat: a value this build does not recognise must not
  // inherit the confident chip by default.
  assert.match(rateChip(900, "something-new", "ok").x, /our prices/);
});

test("a missing field keeps today's behaviour rather than crying wolf", () => {
  // An older press sends no `benchmarked_against`. Undefined is not evidence
  // of a fleet comparison, and a caveat on every answer would train a reader
  // to ignore it.
  assert.equal(rateChip(900, undefined, undefined).x, "over the rate");
});
