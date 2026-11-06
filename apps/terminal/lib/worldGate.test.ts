/* The World gate verdict: a truth table that needs no chain.
 *
 * The decision this pins is whether the page may say "armed". Getting that
 * wrong in the flattering direction is the failure that matters, so every case
 * below starts from a fully-armed state and breaks exactly one thing. */
import assert from "node:assert/strict";
import test from "node:test";

import { ZERO_BYTES32, gateVerdict, type WorldGateState } from "./worldGate";

const OWNER = "0x64E21e01e7D9Abfd4C32cfaC4F590B24ECf38d16";
const PRESS_APPROVER = "0x674f6f1347b0A73014B85f6CCe17a7ECCACAE7AF";
const PRESS_REGISTRAR = "0xde52035E5857ae08d308A4b33d01e63173eF6C10";
const BOUND = `0x${"79".repeat(32)}`;

const armed = (over: Partial<WorldGateState> = {}): WorldGateState => ({
  vault: "0xb030e7e592eb2d8a989c7cbca01270b957bb4bdc",
  chainId: 5042002,
  treasurerBinding: BOUND,
  humanApprover: PRESS_APPROVER,
  guestRegistrar: PRESS_REGISTRAR,
  owner: OWNER,
  paused: false,
  ...over,
});

test("a rotated, bound, unpaused vault is armed and has nothing outstanding", () => {
  const v = gateVerdict(armed());
  assert.equal(v.armed, true);
  assert.equal(v.bound, true);
  assert.deepEqual(v.outstanding, []);
});

test("a zero binding is not armed, and says the chain pins nobody", () => {
  const v = gateVerdict(armed({ treasurerBinding: ZERO_BYTES32 }));
  assert.equal(v.armed, false);
  assert.equal(v.bound, false);
  assert.ok(v.outstanding.some((s) => s.includes("setTreasurerBinding")));
});

test("an approver still equal to the owner has provably never been rotated", () => {
  //: `wire()` points every role at the deployer, so role == owner is a FACT
  //: about the chain rather than a guess about which key the press holds.
  const v = gateVerdict(armed({ humanApprover: OWNER }));
  assert.equal(v.armed, false);
  assert.ok(v.outstanding.some((s) => s.includes("setApprover")));
});

test("a registrar still equal to the owner is named too", () => {
  const v = gateVerdict(armed({ guestRegistrar: OWNER }));
  assert.equal(v.armed, false);
  assert.ok(v.outstanding.some((s) => s.includes("setGuestRegistrar")));
});

test("the comparison is case-insensitive, because checksums differ by case", () => {
  //: An address read off the chain is checksummed and one typed into config
  //: may not be. A case-sensitive compare would report a rotated role as
  //: un-rotated, which is the safe direction but still wrong.
  const v = gateVerdict(armed({ humanApprover: OWNER.toLowerCase() }));
  assert.equal(v.armed, false, "lower-cased owner must still match owner");
});

test("paused comes FIRST, because nothing else matters while it is", () => {
  const v = gateVerdict(armed({ paused: true }));
  assert.equal(v.armed, false);
  assert.match(v.outstanding[0], /paused/);
});

test("the live public vault, as it stands today, is not armed in three ways", () => {
  //: The real state on 2026-11-06, so this file fails the day it changes and
  //: somebody has to look at why. Roles never rotated, binding zero.
  const v = gateVerdict(armed({
    humanApprover: OWNER,
    guestRegistrar: OWNER,
    treasurerBinding: ZERO_BYTES32,
  }));
  assert.equal(v.armed, false);
  assert.equal(v.outstanding.length, 3);
  assert.equal(v.bound, false);
});

test("armed is never claimed on a partially rotated vault", () => {
  //: The one mistake that would matter: two of three done reading as ready.
  const v = gateVerdict(armed({ guestRegistrar: OWNER }));
  assert.equal(v.armed, false);
});
