import { test } from "node:test";
import assert from "node:assert/strict";
import { marginBps, marginReason, type PrintAge } from "./margin.ts";

/**
 * The thing under test is a FILTER, and a filter that cannot be observed
 * filtering is decoration. So most of these cases are built so that including
 * the stale print and excluding it give DIFFERENT numbers — if the staleness
 * check were deleted, the assertions below would not merely weaken, they would
 * be arithmetically wrong.
 *
 * The bound comes from the chain (`policy.maxPrintAge`), so it is a parameter
 * here rather than a constant. 1800 is used in the fixtures because that is
 * what the deployed policy carries, but nothing asserts the literal.
 */

const MAX_AGE = 1800n;
const NOW = 1_000_000n;

const at = (ageS: number, ciBps: number): PrintAge => ({
  ciBps,
  postedAt: NOW - BigInt(ageS),
});

test("all prints fresh: the margin is their mean and nothing is skipped", () => {
  const m = marginBps([at(10, 500), at(20, 1000), at(30, 1500)], NOW, MAX_AGE);
  assert.equal(m.measured, true);
  if (!m.measured) return;
  assert.equal(m.bps, 1000n, "(500 + 1000 + 1500) / 3");
  assert.equal(m.used, 3);
  assert.equal(m.skipped, 0);
});

test("A STALE PRINT IS EXCLUDED, AND IT CHANGES THE ANSWER", () => {
  // The whole point, arranged so the filter is load-bearing. The stale index
  // carries a wildly different confidence, so including it would move the mean
  // a long way:
  //   filtered   (500 + 700) / 2        = 600
  //   unfiltered (500 + 700 + 9000) / 3 = 3400
  const prints = [at(10, 500), at(20, 700), at(5000, 9000)];
  const m = marginBps(prints, NOW, MAX_AGE);
  assert.equal(m.measured, true);
  if (!m.measured) return;
  assert.equal(m.bps, 600n, "the stale index's confidence is not evidence");
  assert.notEqual(m.bps, 3400n, "which is what averaging it anyway would give");
  assert.equal(m.used, 2);
  assert.equal(m.skipped, 1, "and the caller is told one was dropped");
});

test("the boundary is inclusive: exactly maxPrintAge still counts", () => {
  // `FloatVault.classify` refuses when `now - postedAt > maxPrintAge`, so a
  // print of exactly that age is still payable on chain. The keeper must not be
  // stricter than the rule it is reading, or the two disagree about the same
  // print.
  const onTheLine = marginBps([at(1800, 400)], NOW, MAX_AGE);
  assert.equal(onTheLine.measured, true, "age == maxPrintAge is fresh, as on chain");

  const oneOver = marginBps([at(1801, 400)], NOW, MAX_AGE);
  assert.equal(oneOver.measured, false, "and one second past it is not");
});

test("a print from the future is skipped, not trusted", () => {
  // A negative age would make `now - postedAt` underflow on a bigint and throw,
  // and the chain guards the same case (`postedAt > block.timestamp`) before
  // subtracting. Treating it as stale keeps one definition of too-old-to-trust.
  const m = marginBps([{ ciBps: 9999, postedAt: NOW + 60n }, at(10, 500)], NOW, MAX_AGE);
  assert.equal(m.measured, true);
  if (!m.measured) return;
  assert.equal(m.bps, 500n, "only the real print counted");
  assert.equal(m.skipped, 1);
});

test("every print stale: not measured, rather than a silent zero", () => {
  // Returning 0bp here would be indistinguishable from "the providers agree
  // perfectly", which is the opposite of what is true.
  const m = marginBps([at(5000, 900), at(9000, 1200)], NOW, MAX_AGE);
  assert.equal(m.measured, false);
  assert.equal(m.skipped, 2);
  assert.match(marginReason(m, MAX_AGE), /no margin/);
  assert.match(marginReason(m, MAX_AGE), /1800s/, "the bound it used is named");
});

test("no prints at all is not measured either", () => {
  const m = marginBps([], NOW, MAX_AGE);
  assert.equal(m.measured, false);
  assert.equal(m.skipped, 0);
});

test("the mean floors rather than rounding, so the margin is never overstated", () => {
  // 500 + 501 = 1001, / 2 = 500.5 -> 500. A margin is a cushion; overstating it
  // would park less than the forecast asked for.
  const m = marginBps([at(10, 500), at(10, 501)], NOW, MAX_AGE);
  assert.equal(m.measured, true);
  if (!m.measured) return;
  assert.equal(m.bps, 500n);
});

test("the reason line says whether anything was dropped", () => {
  const clean = marginBps([at(10, 500)], NOW, MAX_AGE);
  assert.match(marginReason(clean, MAX_AGE), /all 1 inside 1800s/);

  const dropped = marginBps([at(10, 500), at(5000, 9000)], NOW, MAX_AGE);
  assert.match(marginReason(dropped, MAX_AGE), /1 index\(es\) skipped/);
  assert.match(marginReason(dropped, MAX_AGE), /stale confidence is not in this number/);
});

test("a widened policy widens what counts, because the bound is read not assumed", () => {
  // The reason `maxPrintAge` is settable at all is so the operator can widen it
  // without a redeploy. A keeper carrying its own constant would ignore that.
  const print = [at(3000, 800)];
  assert.equal(marginBps(print, NOW, 1800n).measured, false, "stale under the current policy");
  assert.equal(marginBps(print, NOW, 3600n).measured, true, "fresh under a wider one");
});
