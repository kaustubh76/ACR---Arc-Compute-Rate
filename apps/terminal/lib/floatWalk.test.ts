import { test } from "node:test";
import assert from "node:assert/strict";

import { fairMatches, pickPay, pickPull, pickReceipt, same, verdictOf, type WalkLog } from "./floatWalk";

const VAULT = "0xb030e7e592eb2d8a989c7cbca01270b957bb4bdc";
const SLEEVE = "0xdBeCAE19B2A082B51FC4f0dF59cBFfd1cB12ad14";
const USDC = "0x3600000000000000000000000000000000000000";
const SELLER = "0xf4e89e34ed6e1626a3410e1d49796779179915c1";

const log = (idx: number, addr: string, name: string, args: Record<string, unknown> = {}): WalkLog =>
  ({ idx, addr, name, args });

test("addresses compare without caring what case the node used", () => {
  assert.ok(same(SLEEVE, SLEEVE.toLowerCase()));
  assert.ok(same(VAULT.toUpperCase(), VAULT));
  assert.ok(!same(VAULT, SELLER));
  assert.ok(!same(undefined, VAULT));
});

test("the payment is matched on WHO was paid, not on size or position", () => {
  /* The trap this rule exists for: a bigger transfer earlier in the same
     transaction that went somewhere else entirely. */
  const logs = [
    log(0, USDC, "Transfer", { to: "0xdead00000000000000000000000000000000beef", value: 9_000_000n }),
    log(1, USDC, "Transfer", { to: SELLER, value: 1_055_250n }),
  ];
  const pay = pickPay(logs, USDC, SELLER, 1_055_250n);
  assert.equal(pay?.idx, 1);
  // and with no quote to match on, any transfer to the seller still beats none
  assert.equal(pickPay(logs, USDC, SELLER, undefined)?.idx, 1);
  assert.equal(pickPay(logs, USDC, "0x0000000000000000000000000000000000000009", 1n), null);
});

test("the pull is the one that most closely precedes the payment", () => {
  /* A rebalance pull and a just-in-time pull can both appear. The one that
     funded THIS payment is the last before it, not the first in the list. */
  const logs = [
    log(0, SLEEVE, "Pulled", { usdcRequested: 1n, usdcDelivered: 1n }),
    log(5, SLEEVE, "Pulled", { usdcRequested: 530_250n, usdcDelivered: 530_250n }),
    log(7, USDC, "Transfer", { to: SELLER, value: 1_055_250n }),
  ];
  assert.equal(pickPull(logs, SLEEVE, 7)?.idx, 5);
  /* With no payment identified there is no "precedes" to honour, so the most
     recent pull in the transaction is the best available answer. The verdict
     is what carries the uncertainty: a pull with no pay is `unproven`, never
     `in_order`. */
  assert.equal(pickPull(logs, SLEEVE, null)?.idx, 5);
  assert.equal(verdictOf(pickPull(logs, SLEEVE, null)!.idx, null, true), "unproven");
  assert.equal(pickPull([], SLEEVE, 7), null);
});

test("the receipt preferred is the one claiming just-in-time funding", () => {
  const logs = [
    log(2, VAULT, "Receipt", { jitFunded: false, quote: 1n }),
    log(9, VAULT, "Receipt", { jitFunded: true, quote: 2n }),
  ];
  assert.equal(pickReceipt(logs, VAULT)?.idx, 9, "the claim under test wins");
  assert.equal(pickReceipt([logs[0]], VAULT)?.idx, 2, "otherwise the only one");
  assert.equal(pickReceipt([], VAULT), null);
  assert.equal(pickReceipt(logs, SELLER), null, "and it must come from the vault");
});

test("pull before pay is the proof; pay before pull is not", () => {
  assert.equal(verdictOf(5, 7, true), "in_order");
  assert.equal(verdictOf(7, 5, true), "out_of_order");
  assert.equal(verdictOf(5, 7, false), "in_order", "order holds whether or not it was claimed");
});

test("a payment that never claimed just-in-time is not a failure", () => {
  /* The distinction a two-state verdict would destroy. No pull is expected
     when the buffer covered the payment, and reporting that as a problem would
     teach a reader to distrust a healthy treasury. */
  assert.equal(verdictOf(null, 7, false), "not_jit");
  assert.equal(verdictOf(null, null, false), "not_jit");
});

test("a claim with a missing log is unproven, which is neither pass nor fail", () => {
  assert.equal(verdictOf(null, 7, true), "unproven");
  assert.equal(verdictOf(5, null, true), "unproven");
  assert.notEqual(verdictOf(null, 7, true), "out_of_order");
  assert.notEqual(verdictOf(null, 7, true), "in_order");
});

test("the fair price is recomputed against the print the receipt names", () => {
  // gpt-4o-mini at 0.0002625 per 1k tokens, 4,000 units -> 1.05 USDC
  const priceWad = 262_500_000_000_000n;
  assert.equal(fairMatches(priceWad, 4_000n, 1_050_000n), true);
  assert.equal(fairMatches(priceWad, 4_000n, 1_050_001n), false);
  /* A print that could not be found is an absence, not a mismatch: the walk
     says the print is not shown rather than that the price was wrong. */
  assert.equal(fairMatches(null, 4_000n, 1_050_000n), null);
});
