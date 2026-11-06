/* The World gate verdict: a truth table that needs no chain.
 *
 * The decision this pins is whether the page may say "armed". Getting that
 * wrong in the flattering direction is the failure that matters, so every case
 * below starts from a fully-armed state and breaks exactly one thing. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  GOVERNS,
  UNGOVERNED,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  gateVerdict,
  type WorldGateState,
} from "./worldGate";

const OWNER = "0x64E21e01e7D9Abfd4C32cfaC4F590B24ECf38d16";
const PRESS_APPROVER = "0x674f6f1347b0A73014B85f6CCe17a7ECCACAE7AF";
const PRESS_REGISTRAR = "0xde52035E5857ae08d308A4b33d01e63173eF6C10";
const BOUND = `0x${"79".repeat(32)}`;
//: Measured on chain 2026-11-07. The keeper really is a separate key, which is
//: why a test asserting `keeper == owner` would have been a fiction.
const KEEPER = "0x3111B1a058AE3ec480A186b21362b0DF85b0f597";
const WORKING = "0xdbeCAe19b2a082b51fc4F0DF59cbfFD1cB12ad14";
const RESERVE = "0x1111111111111111111111111111111111111111";

const armed = (over: Partial<WorldGateState> = {}): WorldGateState => ({
  vault: "0xb030e7e592eb2d8a989c7cbca01270b957bb4bdc",
  chainId: 5042002,
  treasurerBinding: BOUND,
  humanApprover: PRESS_APPROVER,
  guestRegistrar: PRESS_REGISTRAR,
  owner: OWNER,
  paused: false,
  keeper: KEEPER,
  working: WORKING,
  reserve: RESERVE,
  ...over,
});

test("a rotated, bound, unpaused vault is armed and has nothing outstanding", () => {
  const v = gateVerdict(armed());
  assert.equal(v.armed, true);
  assert.equal(v.bound, true);
  assert.deepEqual(v.outstanding, []);
  //: THE LOAD-BEARING ASSERTION OF THE WHOLE DESIGN. The yield boundary is
  //: reported on a fully armed vault and does NOT disarm it. Put those facts in
  //: `outstanding` instead and this is the assertion that fails.
  assert.ok(v.governs.length > 0);
  assert.ok(v.ungoverned.length > 0);
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

// --- the boundary: what the enrolled human does not govern ------------------

test("the yield path is named as ungoverned, never as something a transaction fixes", () => {
  const v = gateVerdict(armed());
  const said = v.ungoverned.join(" ");
  assert.ok(said.includes("rebalance"));
  assert.ok(said.includes("setSleeves"));
  //: THE DRIFT GUARD. The page renders these constants directly when the chain
  //: cannot be read, so a sentence that exists in only one of the two places
  //: would show up for some readers and not others.
  assert.ok(GOVERNS.length > 0 && UNGOVERNED.length > 0);
  for (const g of GOVERNS) assert.ok(v.governs.includes(g), `governs lost: ${g}`);
  for (const u of UNGOVERNED) assert.ok(v.ungoverned.includes(u), `ungoverned lost: ${u}`);
  //: No owner transaction changes bytecode, so none of this may leak into the
  //: list the page promises is one transaction each.
  assert.deepEqual(v.outstanding, []);
});

test("what the human DOES govern is phrased about the contract, so it survives an unbound vault", () => {
  const v = gateVerdict(armed({ treasurerBinding: ZERO_BYTES32 }));
  assert.equal(v.bound, false);
  const said = v.governs.join(" ");
  assert.ok(said.includes("executeApproved"));
  assert.ok(said.includes("requirePolicyCheckpoint"));
});

test("an unwired reserve sleeve is named, because the split degrades silently", () => {
  const v = gateVerdict(armed({ reserve: ZERO_ADDRESS }));
  assert.ok(v.ungoverned.some((s) => s.includes("no reserve sleeve is wired")));
  //: It is a disclosure, not a task: the vault is still armed.
  assert.equal(v.armed, true);
});

test("a keeper that is also the approver IS outstanding, because one setKeeper fixes it", () => {
  const v = gateVerdict(armed({ keeper: PRESS_APPROVER }));
  assert.equal(v.armed, false);
  assert.ok(v.outstanding.some((s) => s.includes("setKeeper")));
});

test("the live public vault, as measured today: three rotations outstanding and NO keeper collision", () => {
  const v = gateVerdict(
    armed({
      humanApprover: OWNER,
      guestRegistrar: OWNER,
      treasurerBinding: ZERO_BYTES32,
      keeper: KEEPER,
      reserve: ZERO_ADDRESS,
    }),
  );
  assert.equal(v.armed, false);
  assert.equal(v.outstanding.length, 3);
  assert.ok(!v.outstanding.some((s) => s.includes("setKeeper")));
  assert.ok(v.ungoverned.some((s) => s.includes("no reserve sleeve is wired")));
});
