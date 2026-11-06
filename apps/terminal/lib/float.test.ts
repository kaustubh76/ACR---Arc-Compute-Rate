import { test } from "node:test";
import assert from "node:assert/strict";

import { countdown, isAgentAddress, premiumPct, statusChip, type FloatStatus, wrongChain } from "./float";

/* The four helpers every float surface renders through, which had no test.

   Each one encodes a decision the module's own comments argue for, and each of
   those decisions is the kind that survives a refactor only if something
   asserts it: an absent premium that must read as an ellipsis and not as zero,
   a chip tier per outcome, a countdown that floors rather than going negative,
   and an address check that is deliberately looser than a checksum. */

test("a premium is a percentage over the chain's own fair price", () => {
  assert.equal(premiumPct({ quote_usdc: 18, fair_usdc: 17.4 })?.toFixed(1), "3.4");
  assert.equal(premiumPct({ quote_usdc: 10, fair_usdc: 10 }), 0);
  // the contract's premiumBps is int256: a quote below fair is legal
  assert.ok(premiumPct({ quote_usdc: 9, fair_usdc: 10 })! < 0);
  assert.equal(premiumPct({ quote_usdc: 30, fair_usdc: 10 }), 200);
});

test("no fair price is null, which renders as an ellipsis and never as zero", () => {
  /* The distinction the module argues for: a zero premium means "priced exactly
     at fair", which is a real and good answer. Folding "we have no print to
     compare against" into it would print the best possible verdict on the one
     case where nothing is known. */
  assert.equal(premiumPct({ quote_usdc: 18, fair_usdc: 0 }), null);
  assert.equal(premiumPct({ quote_usdc: 18, fair_usdc: -1 }), null);
  assert.equal(premiumPct({ quote_usdc: 18, fair_usdc: Number.NaN }), null);
  assert.equal(premiumPct({ quote_usdc: Number.NaN, fair_usdc: 17.4 }), null);
});

test("every outcome the press can send has a chip tier, and they differ by meaning", () => {
  const tiers: Record<FloatStatus, string> = {
    consumed: "chip-teal",
    open: "chip-sky",
    claimed: "chip-sky",
    denied: "chip-breach",
    failed: "chip-breach",
    expired: "chip-sim",
  };
  for (const [status, chip] of Object.entries(tiers)) {
    assert.equal(statusChip(status as FloatStatus), chip, `${status} should be ${chip}`);
  }
  /* A paid payment and a refused one must never share a colour, and a window
     that merely closed is neither: nobody refused it. */
  assert.notEqual(statusChip("consumed"), statusChip("denied"));
  assert.notEqual(statusChip("expired"), statusChip("denied"));
  assert.notEqual(statusChip("open"), statusChip("consumed"));
});

test("the countdown floors at zero and keeps two digits of seconds", () => {
  assert.equal(countdown(300), "5:00");
  assert.equal(countdown(299), "4:59");
  assert.equal(countdown(61), "1:01");
  assert.equal(countdown(9), "0:09");
  assert.equal(countdown(0), "0:00");
  /* A negative duration is what a clock that has run past its deadline
     produces, and "-1:-1" on an approval card would read as a bug rather than
     as an expiry. */
  assert.equal(countdown(-5), "0:00");
  assert.equal(countdown(0.9), "0:00");
  // above an hour it still reads as minutes rather than wrapping
  assert.equal(countdown(3_661), "61:01");
});

test("an agent address is checked for shape, not for checksum", () => {
  /* The module's reason, verbatim: a visitor pasting from a block explorer gets
     mixed case and a visitor typing gets lower, and refusing the second would be
     refusing the commoner case. */
  assert.ok(isAgentAddress("0x64E21e01e7D9Abfd4C32cfaC4F590B24ECf38d16"));
  assert.ok(isAgentAddress("0x64e21e01e7d9abfd4c32cfac4f590b24ecf38d16"));
  assert.ok(isAgentAddress("  0x64e21e01e7d9abfd4c32cfac4f590b24ecf38d16  "));
  assert.ok(!isAgentAddress("64e21e01e7d9abfd4c32cfac4f590b24ecf38d16"));
  assert.ok(!isAgentAddress("0x64e21e01e7d9abfd4c32cfac4f590b24ecf38d1"));
  assert.ok(!isAgentAddress("0x64e21e01e7d9abfd4c32cfac4f590b24ecf38d160"));
  assert.ok(!isAgentAddress("0xZZZ1e01e7d9abfd4c32cfac4f590b24ecf38d16"));
  assert.ok(!isAgentAddress(""));
});

test("a chain that would not answer is not a chain the reader is on the wrong side of", () => {
  /* `status: "pending"` means two unrelated things and only one of them has a
     network to switch to. `/float` branched on the status alone and showed
     "NOT ON THIS CHAIN. Switch the network" — with no button, because there was
     nothing to switch to — to a reader on the correct chain whose only problem
     was a rate limit. Witnessed on a freshly started server while the route
     answered `status: "ok"` seconds later. */

  /* The genuine case: the config refused AND named somewhere to go. */
  assert.equal(wrongChain({ status: "pending", switch_to: "testnet" }), true);
  assert.equal(wrongChain({ status: "pending", switch_to: "mainnet" }), true);

  /* THE CASE THAT WAS WRONG. Both of these are "the chain did not answer", and
     neither is the reader's fault; they must fall through to the unreachable
     copy, which already says it retries by itself. */
  assert.equal(wrongChain({ status: "pending" }), false, "rate limited is not wrong-chain");
  assert.equal(wrongChain({ status: "pending", switch_to: undefined }), false);

  /* A healthy read is not pending at all, whatever else it carries. */
  assert.equal(wrongChain({ status: "ok" }), false);
  assert.equal(wrongChain({ status: "ok", switch_to: "testnet" }), false, "ok outranks a stale hint");

  /* Nothing asked yet is not an answer about chains. */
  assert.equal(wrongChain(null), false);
  assert.equal(wrongChain(undefined), false);
});
