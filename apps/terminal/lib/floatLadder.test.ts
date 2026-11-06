import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ESCALATION_CODE,
  LADDER,
  atOrOverThreshold,
  bandCeiling,
  escalates,
  headroom,
  clearedCount,
  parseDenialCode,
  rungState,
  rungSymbol,
  stoppedAt,
  walkedState,
} from "./floatLadder";

/* The ladder, pinned to the contract that owns it.

   A table of twelve numbers copied out of Solidity is a table that drifts, and
   it drifts silently: every number still parses, the UI still renders, and the
   rung it lights is simply the wrong one. So the first test reads
   FloatVault.sol off disk and drives the real constants through this module —
   the drift gate `float/src/policy.test.ts` already uses against
   policy.schema.json, pointed at a different source of truth.

   The contract is two directories up and outside this npm package. When it is
   absent the test says so rather than passing: a gate that quietly skips is the
   thing `a gate that could not finish` was about. CI checks out the whole repo,
   so absent means something is wrong with the path, not with the checkout. */

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT_SOL = join(HERE, "..", "..", "..", "contracts", "src", "float", "FloatVault.sol");

test("every rung matches the constant FloatVault.sol declares for it", () => {
  assert.ok(existsSync(VAULT_SOL), `cannot read the contract that owns these codes: ${VAULT_SOL}`);
  const src = readFileSync(VAULT_SOL, "utf8");

  /* Only the refusal codes. `uint8 public constant D_…` is the declaration
     shape; KIND_SPEND and WAD_TO_USDC are other widths and other prefixes, so
     the `D_` in the pattern is doing real work. */
  const declared = new Map<string, number>();
  for (const m of src.matchAll(/uint8\s+public\s+constant\s+(D_[A-Z_]+)\s*=\s*(\d+)\s*;/g)) {
    declared.set(m[1], Number(m[2]));
  }

  assert.equal(
    declared.size,
    LADDER.length,
    `FloatVault declares ${declared.size} refusal codes and this ladder carries ${LADDER.length}`,
  );
  for (const rung of LADDER) {
    assert.equal(declared.get(rung.name), rung.code, `${rung.name} is ${declared.get(rung.name)} on chain`);
  }
});

test("the rungs are in the order the ladder runs them, with no gaps", () => {
  assert.deepEqual(
    LADDER.map((r) => r.code),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
});

test("the escalation rung is the one the contract exempts from burning its nonce", () => {
  assert.ok(existsSync(VAULT_SOL));
  const src = readFileSync(VAULT_SOL, "utf8");
  /* The comment is the specification: "The ONE exception is `D_PER_REQUEST`,
     because that refusal is not a refusal — it is an escalation". If the
     contract ever names a different code there, this constant is wrong. */
  assert.match(src, /ONE exception is `D_PER_REQUEST`/);
  const rung = LADDER.find((r) => r.code === ESCALATION_CODE);
  assert.equal(rung?.name, "D_PER_REQUEST");
});

test("a parked request lights gold; it is not painted as a refusal", () => {
  const band = LADDER.find((r) => r.name === "D_BAND")!;
  const perReq = LADDER.find((r) => r.name === "D_PER_REQUEST")!;
  assert.equal(rungState(perReq, 11), "lit");
  assert.equal(rungState(band, 10), "blocked");
  assert.ok(escalates(11));
  assert.ok(!escalates(10));
  assert.ok(!escalates(0));
});

test("rungs below the code passed, rungs above were never reached", () => {
  const first = LADDER[0];
  const paused = LADDER.find((r) => r.name === "D_PAUSED")!;
  const cap = LADDER.find((r) => r.name === "D_DAILY_CAP")!;
  const band = LADDER.find((r) => r.name === "D_BAND")!;

  // the band bit: everything cheaper than it cleared, the cap was never asked
  assert.equal(rungState(paused, 10), "passed");
  assert.equal(rungState(cap, 10), "dim");
  assert.equal(rungState(band, 10), "blocked");

  // allowed: the whole ladder cleared
  assert.equal(rungState(first, 0), "passed");
  assert.equal(rungState(cap, 0), "passed");
});

test("an unreadable answer dims the ladder rather than reading as allowed", () => {
  for (const rung of LADDER) assert.equal(rungState(rung, null), "dim");
  assert.equal(parseDenialCode(undefined), null);
  assert.equal(parseDenialCode("not a code"), null);
  assert.equal(parseDenialCode(13), null);
  assert.equal(parseDenialCode(-1), null);
  assert.equal(parseDenialCode(1.5), null);
  assert.equal(parseDenialCode(0), 0);
  assert.equal(parseDenialCode("11"), 11);
  assert.equal(parseDenialCode(12), 12);
});

test("the band ceiling is the contract's bound carried into decimal usdc", () => {
  // policy.config.json ships maxPremiumBps 100 and humanMaxPremiumBps 2000
  assert.equal(bandCeiling(10, 100), 10.1);
  assert.equal(bandCeiling(10, 2_000), 12);
  assert.equal(bandCeiling(17.4, 0), 17.4);
  // an approval widens the band and never removes it
  const agentBand = bandCeiling(17.4, 100)!;
  const humanBand = bandCeiling(17.4, 2_000)!;
  assert.ok(humanBand > agentBand, "the human band must be the wider of the two");
});

test("no fair price bands against nothing, and never against zero", () => {
  assert.equal(bandCeiling(0, 100), null);
  assert.equal(bandCeiling(-1, 100), null);
  assert.equal(bandCeiling(Number.NaN, 100), null);
  assert.equal(bandCeiling(10, -1), null);
  assert.equal(bandCeiling(10, Number.NaN), null);
});

test("the per-request boundary is inclusive, as the contract's convention is", () => {
  // scout ships perRequestUsdc "5": 4.999999 is its own authority, 5 escalates
  assert.ok(!atOrOverThreshold(4.999999, 5));
  assert.ok(atOrOverThreshold(5, 5));
  assert.ok(atOrOverThreshold(5.000001, 5));
  assert.ok(!atOrOverThreshold(1, 5));
  // an unset threshold is not a threshold of zero, which would escalate everything
  assert.ok(!atOrOverThreshold(1, 0));
  assert.ok(!atOrOverThreshold(1, Number.NaN));
});

test("a cap already spent has no headroom, and never negative headroom", () => {
  assert.equal(headroom(25, 0), 25);
  assert.equal(headroom(25, 20), 5);
  assert.equal(headroom(25, 25), 0);
  assert.equal(headroom(25, 40), 0);
  assert.equal(headroom(Number.NaN, 1), null);
  assert.equal(headroom(25, -1), null);
});

test("the light travels all twelve, so the tail past the stop settles to not-reached", () => {
  const code = 10 as const;
  /* Mid-walk: the light is at rung 6, so rungs 1..5 have painted the chain's
     answer and 7..12 have not been reached by the LIGHT yet. `queued` and not
     `dim`, because a dashed box claims the ladder never got there and at this
     instant that is simply not known to the reader. */
  assert.equal(walkedState(LADDER[0], code, 6), "passed");
  assert.equal(walkedState(LADDER[5], code, 6), "passed");
  assert.equal(walkedState(LADDER[6], code, 6), "queued");
  assert.equal(walkedState(LADDER[11], code, 6), "queued");

  /* Settled: the walk reached the end, so the rung that answered is blocked and
     the two behind it are unreached. If the walk had stopped at the answer,
     rungs 11 and 12 would sit in `queued` for ever. */
  const settled = LADDER.map((r) => walkedState(r, code, LADDER.length));
  assert.deepEqual(settled.slice(0, 9), Array(9).fill("passed"));
  assert.equal(settled[9], "blocked");
  assert.deepEqual(settled.slice(10), ["dim", "dim"]);
});

test("no answer yet is RUNNING, not unreached: three facts that used to paint alike", () => {
  /* The first paint of the page. Every rung is waiting on one read, which is a
     different fact from "the ladder never reached this rung" and was drawn the
     same way: twelve dashed boxes that read as a rendering fault. */
  for (const r of LADDER) {
    assert.equal(walkedState(r, null, 0), "running");
    assert.equal(walkedState(r, null, LADDER.length), "running", "a walk cannot outrun a missing answer");
  }
  /* And `dim` still means unreached, for a rung behind a real stop. */
  assert.equal(walkedState(LADDER[11], 3, LADDER.length), "dim");
});

test("the escalation rung paints lit, mid-walk and settled", () => {
  assert.equal(walkedState(LADDER[ESCALATION_CODE - 1], ESCALATION_CODE, LADDER.length), "lit");
  assert.equal(walkedState(LADDER[ESCALATION_CODE - 1], ESCALATION_CODE, ESCALATION_CODE - 1), "queued");
});

test("stoppedAt names the deciding rung, and nothing when there is not one", () => {
  assert.equal(stoppedAt(10), 10);
  assert.equal(stoppedAt(ESCALATION_CODE), ESCALATION_CODE);
  /* Both of these have no deciding rung, and a number here would invent one. */
  assert.equal(stoppedAt(0), null);
  assert.equal(stoppedAt(null), null);
});

test("clearedCount is how far the vault GOT, which is one less than the rung that stopped it", () => {
  assert.equal(clearedCount(0), LADDER.length, "cleared every one");
  assert.equal(clearedCount(1), 0, "the first rung answered, so none cleared");
  assert.equal(clearedCount(10), 9);
  assert.equal(clearedCount(LADDER.length), LADDER.length - 1);
  assert.equal(clearedCount(null), 0, "nothing asked yet is not progress");
});

test("every paint has its own mark, so state never rests on colour alone", () => {
  const marks = (["passed", "blocked", "lit", "dim", "queued", "running"] as const).map(rungSymbol);
  /* The three that a reader must tell apart at a glance have to differ. The two
     waiting states share the neutral dot on purpose: neither is a verdict. */
  assert.notEqual(marks[0], marks[1], "cleared and stopped must differ");
  assert.notEqual(marks[0], marks[2], "cleared and escalated must differ");
  assert.notEqual(marks[1], marks[2], "stopped and escalated must differ");
  for (const m of marks) assert.ok(m.length > 0, "every paint carries a mark");
});
