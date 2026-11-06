import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countVenueLogs,
  fairMatches,
  pickPay,
  pickPull,
  pickReceipt,
  pickShareBurn,
  pickVenueWithdraw,
  same,
  verdictOf,
  type WalkLog,
} from "./floatWalk";

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

/* --- the venue's own leg, against the REAL receipt ----------------------- */

/* Every venue log from the canonical payment, tx 0x7f3fa68c…, block 71059012.
   Four of them, and only two decode against any ABI this repo holds. The
   indices and figures are the chain's, not invented: assets 1055250 at log 29
   with the receiver set to the VAULT, and 1054134341145566439 shares burned to
   the zero address at log 26. */
const VENUE = "0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88";
const ZERO = "0x0000000000000000000000000000000000000000";
const SHARES = 1_054_134_341_145_566_439n;

const realDecoded: WalkLog[] = [
  // log 16 and log 25 are the venue's, decode against nothing, and are absent here
  log(26, VENUE, "Transfer", { from: SLEEVE, to: ZERO, value: SHARES }),
  log(29, VENUE, "Withdraw", { caller: SLEEVE, receiver: VAULT, owner: SLEEVE, assets: 1_055_250n, shares: SHARES }),
  log(30, SLEEVE, "Pulled", { usdcRequested: 1_055_250n, usdcDelivered: 1_055_250n }),
  log(32, USDC, "Transfer", { to: SELLER, value: 1_055_250n }),
  log(33, VAULT, "Receipt", { jitFunded: true }),
];

test("the venue's exit is log 29, and log 16 is not mistaken for it", () => {
  /* THE TRAP THIS FUNCTION EXISTS FOR. The venue emits at 16, 25, 26 and 29 in
     one payment. Taking the first log from that address puts Morpho ahead of
     the price read, which is both wrong and flattering: it would show the venue
     acting before the vault had decided anything. */
  const w = pickVenueWithdraw(realDecoded, VENUE, 32);
  assert.equal(w?.idx, 29);
  assert.equal(w?.args.assets, 1_055_250n);

  // and with log 16 present as something undecodable-turned-decodable, still 29
  const withEarly = [log(16, VENUE, "AccrueInterest", {}), ...realDecoded];
  assert.equal(pickVenueWithdraw(withEarly, VENUE, 32)?.idx, 29);
});

test("the venue's exit precedes our sleeve's record of it", () => {
  /* The order that makes the venue worth drawing at all: the party we do not
     control released the money, and only then did our wrapper record it. */
  const w = pickVenueWithdraw(realDecoded, VENUE, 32);
  const pull = pickPull(realDecoded, SLEEVE, 32);
  assert.ok(w && pull && w.idx < pull.idx, "29 before 30");
});

test("the receiver is the TREASURY, which is the one-hop claim", () => {
  const w = pickVenueWithdraw(realDecoded, VENUE, 32);
  assert.ok(same(String(w?.args.receiver), VAULT), "straight to the vault, never resting in the sleeve");
  assert.ok(!same(String(w?.args.receiver), SLEEVE));
});

test("a withdraw from somewhere else is not the venue's", () => {
  /* VENUE_ABI now carries the event, so any ERC-4626 withdraw in the receipt
     decodes. The address is what makes the pick mean anything. */
  const other = "0x1111111111111111111111111111111111111111";
  const logs = [log(29, other, "Withdraw", { receiver: VAULT, assets: 9n, shares: 9n })];
  assert.equal(pickVenueWithdraw(logs, VENUE, 32), null);
  assert.equal(pickVenueWithdraw(logs, undefined, 32), null, "no venue address, no claim");
});

test("no venue withdraw at all is an absence, not a zero", () => {
  /* A pull from the USYC reserve emits no Morpho log, and nor does a payment
     the buffer covered on its own. */
  const noVenue = realDecoded.filter((l) => l.name !== "Withdraw");
  assert.equal(pickVenueWithdraw(noVenue, VENUE, 32), null);
});

test("the share burn is the sleeve's shares going to the zero address", () => {
  const b = pickShareBurn(realDecoded, VENUE);
  assert.equal(b?.idx, 26);
  assert.equal(b?.args.value, SHARES);
  assert.equal(b?.args.value, realDecoded.find((l) => l.name === "Withdraw")?.args.shares,
    "the burn and the withdraw agree on the share count");
});

test("a USDC transfer is never read as a share burn", () => {
  /* Both are `Transfer`, and only the emitting address tells them apart. */
  const logs = [log(32, USDC, "Transfer", { to: ZERO, value: 5n })];
  assert.equal(pickShareBurn(logs, VENUE), null);
});

test("the venue's logs are counted off the RECEIPT, not off what decoded", () => {
  /* Two of the four match no ABI this repo holds, so counting decoded logs
     would report two and present it as the whole of the venue's activity. */
  const raw = [16, 25, 26, 29].map((i) => ({ address: VENUE, idx: i }))
    .concat([{ address: USDC, idx: 32 }, { address: VAULT, idx: 33 }]);
  assert.equal(countVenueLogs(raw, VENUE), 4);
  assert.equal(countVenueLogs(raw, undefined), 0);
  assert.equal(countVenueLogs([], VENUE), 0);
});
