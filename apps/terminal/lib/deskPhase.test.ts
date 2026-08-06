import { test } from "node:test";
import assert from "node:assert/strict";
import { deskPhase, deskStep, DESK_STEPS, type DeskPhase } from "./deskPhase";

test("a reader who posted their whole stake is TRADING, not unfunded", () => {
  // The bug this file exists for. The faucet drips 0.50 and postCollateral
  // posts 0.50, so a wallet holding 0.00 with collateral on the venue is the
  // ordinary happy path — every reader ends here. Reading the phase off
  // spendable balance sent them back to "unfunded" on the next poll, telling
  // them to claim a stake they had just spent, with no trade button in sight.
  assert.equal(deskPhase({ usdc: 0, collateralized: true }), "trading");
});

test("a funded wallet that has not posted yet is asked for collateral", () => {
  assert.equal(deskPhase({ usdc: 0.5, collateralized: false }), "collateral");
});

test("an empty wallet with nothing posted is genuinely unfunded", () => {
  assert.equal(deskPhase({ usdc: 0, collateralized: false }), "unfunded");
});

test("an unreadable balance does not fake a funded wallet", () => {
  // A throttled read returns null. Claiming "collateral" here would offer a
  // deposit the reader cannot pay for; "unfunded" is the honest degradation,
  // and the venue check upstream can still promote them.
  assert.equal(deskPhase({ usdc: null, collateralized: false }), "unfunded");
});

test("collateral outranks every balance, including an unreadable one", () => {
  // Money on the venue is the fact that matters; the wallet balance is not
  // evidence against it, whatever it says or fails to say.
  for (const usdc of [null, 0, 0.5, 100]) {
    assert.equal(deskPhase({ usdc, collateralized: true }), "trading");
  }
});

test("every phase maps to a step inside the rail", () => {
  const phases: DeskPhase[] = ["closed", "opening", "pin", "unfunded", "collateral", "trading"];
  for (const p of phases) {
    const i = deskStep(p);
    assert.ok(Number.isInteger(i) && i >= 0 && i < DESK_STEPS.length, `${p} → ${i}`);
  }
});

test("opening is step one in flight, not a step of its own", () => {
  // A rail whose first item vanished the moment the reader clicked it would
  // renumber the whole walk underneath them.
  assert.equal(deskStep("opening"), deskStep("closed"));
});

test("the walk runs forward and ends on trade", () => {
  assert.deepEqual(
    (["closed", "pin", "unfunded", "collateral", "trading"] as DeskPhase[]).map(deskStep),
    [0, 1, 2, 3, 4],
  );
  assert.equal(deskStep("trading"), DESK_STEPS.length - 1);
});
