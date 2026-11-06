import { test } from "node:test";
import assert from "node:assert/strict";
import { fundingCheck, fundingReason } from "./funding.ts";

/**
 * The rule under test is narrow on purpose, and the narrowness is the point:
 * hold back ONLY the request that policy would allow and funding would sink.
 *
 * Getting this wrong in the generous direction is worse than not having it.
 * My first version held back any underfunded request regardless of the policy
 * verdict, which would have deleted the waster agent's deliberate 3x refusal
 * from the tape whenever the buffer dipped below three times fair — trading
 * the product's own refusal evidence for a saved cent.
 */

const ALLOWED = 0;
const D_BAND = 10; // "quote exceeds ACR fair band"

test("a policy refusal is sent anyway, because Denied is the evidence", () => {
  // Empty treasury AND a refused quote: still send. `requestSpend` emits
  // `Denied` rather than reverting, so this costs a little gas and buys the
  // on-chain refusal the tape exists to show.
  const f = fundingCheck(D_BAND, 0n, 3_150_000n);
  assert.equal(f.send, true, "a policy-refused request must still reach the chain");
});

test("an affordable, allowed payment is sent", () => {
  assert.equal(fundingCheck(ALLOWED, 8_944_750n, 1_055_250n).send, true);
});

test("exactly affordable is still affordable", () => {
  // The boundary is >=, not >. Holding back a payment the treasury can exactly
  // cover would refuse a correct payment.
  const f = fundingCheck(ALLOWED, 1_055_250n, 1_055_250n);
  assert.equal(f.send, true, "held == quote must send");
});

test("one unit short is held back, and the shortfall is exact", () => {
  const f = fundingCheck(ALLOWED, 1_055_249n, 1_055_250n);
  assert.equal(f.send, false);
  if (f.send) return;
  assert.equal(f.short, 1n, "the shortfall is reported to the unit");
  assert.equal(f.held, 1_055_249n);
  assert.equal(f.quote, 1_055_250n);
});

test("an empty treasury with an allowed quote is held back", () => {
  const f = fundingCheck(ALLOWED, 0n, 1_055_250n);
  assert.equal(f.send, false);
});

test("the reason carries the figures, not just a verdict", () => {
  // A held-back request has to say what it saw, or the next person debugs the
  // vault instead of reading the balance — which is the exact mistake the
  // contract's own "treasury cannot cover this" comment warns about.
  const f = fundingCheck(ALLOWED, 2_000_000n, 5_000_000n);
  const why = fundingReason(f);
  assert.match(why, /\$2\b/, "says what the treasury holds");
  assert.match(why, /\$5\b/, "says what the payment needs");
  assert.match(why, /\$3\b/, "says the shortfall");
  assert.match(why, /revert/, "distinguishes a revert from a refusal");
  assert.match(why, /sweep/, "names the way out, since this is usually the test loop");
});

test("a sent verdict has no reason to give", () => {
  assert.equal(fundingReason(fundingCheck(ALLOWED, 10n, 1n)), "");
});
