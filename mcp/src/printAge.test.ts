import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ageWords,
  PRINT_MAX_AGE_S,
  PRINT_WARN_AGE_S,
  printFreshness,
  staleness,
  worthSaying,
} from "./printAge.js";

/* The thresholds are the press's own. This is the half that keeps them so.
 *
 * `printAge.ts` duplicates two constants because `acr-mcp` publishes standalone
 * and cannot import across the monorepo. A duplicated constant with a comment
 * claiming it matches is worth nothing — `chain.ts` claimed for weeks that its
 * chain table was "pinned by a test instead (`chain.test.ts`)" and that file did
 * not exist. So the claim is executed here instead of asserted in prose.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPS_PY = join(
  __dirname, "..", "..", "services", "index_api", "index_api", "ops.py",
);

test("the thresholds are the press's own, read out of ops.py", () => {
  /* Read, not restated. The regex matches the declaration shape ops.py uses
     (`float(os.environ.get("VERIFY_…", "7200"))`), so a change to the default
     fails here rather than letting two surfaces disagree about whether a print
     is late. Identical mechanism to apps/terminal/lib/printAge.test.ts, which
     is the other copy of these numbers. */
  const src = readFileSync(OPS_PY, "utf8");
  const warn = /PRINT_WARN_AGE_S\s*=\s*float\(os\.environ\.get\("[^"]+",\s*"(\d+)"\)\)/.exec(src);
  const max = /PRINT_MAX_AGE_S\s*=\s*float\(os\.environ\.get\("[^"]+",\s*"(\d+)"\)\)/.exec(src);
  assert.ok(warn, "ops.py should still declare PRINT_WARN_AGE_S");
  assert.ok(max, "ops.py should still declare PRINT_MAX_AGE_S");
  assert.equal(PRINT_WARN_AGE_S, Number(warn[1]), "the warn age drifted from the press's");
  assert.equal(PRINT_MAX_AGE_S, Number(max[1]), "the settle window drifted from the press's");
});

test("the terminal's copy of the same two numbers agrees", () => {
  /* Three copies now: ops.py, the terminal and here. Pinning each to ops.py
     independently would let the two TypeScript copies drift from each other
     while both matched Python — so they are also checked against each other. */
  const TERM = join(__dirname, "..", "..", "apps", "terminal", "lib", "printAge.ts");
  const src = readFileSync(TERM, "utf8");
  const warn = /PRINT_WARN_AGE_S\s*=\s*(\d+)/.exec(src);
  const max = /PRINT_MAX_AGE_S\s*=\s*(\d+)/.exec(src);
  assert.ok(warn && max, "the terminal should still declare both");
  assert.equal(PRINT_WARN_AGE_S, Number(warn[1]));
  assert.equal(PRINT_MAX_AGE_S, Number(max[1]));
});

test("the boundaries are the boundaries", () => {
  const now = 1_800_000_000;
  // Exactly AT a threshold is not past it, which is what `>` means in both
  // copies. Asserted because an off-by-one here is a surface calling a print
  // late one second early, forever.
  assert.equal(printFreshness(now - PRINT_WARN_AGE_S, now).state, "fresh");
  assert.equal(printFreshness(now - (PRINT_WARN_AGE_S + 1), now).state, "late");
  assert.equal(printFreshness(now - PRINT_MAX_AGE_S, now).state, "late");
  assert.equal(printFreshness(now - (PRINT_MAX_AGE_S + 1), now).state, "overdue");
});

test("a missing stamp is unknown, never fresh", () => {
  /* The failure this prevents: a payload that carried no `posted_at` reading as
     a print posted seconds ago. "Did not say" and "said recently" are different
     facts and only one of them is safe to act on. */
  for (const absent of [null, undefined, 0, NaN]) {
    const { state, ageS } = printFreshness(absent as number | null, 1_800_000_000);
    assert.equal(state, "unknown", `${String(absent)} should be unknown`);
    assert.equal(ageS, null);
  }
  assert.equal(worthSaying("unknown"), false, "unknown is not a staleness claim");
  assert.equal(staleness(null, "this print").stale, false, "unknown must not assert staleness");
  assert.match(String(staleness(null, "this print").note), /carried no timestamp/);
});

test("the age is only said when it is news", () => {
  assert.equal(worthSaying("fresh"), false);
  assert.equal(worthSaying("late"), true);
  assert.equal(worthSaying("overdue"), true);
  // A fresh reading gets the fields and no sentence: the numbers are there for
  // a caller who wants them, the prose is reserved for something to act on.
  const fresh = staleness(Math.floor(Date.now() / 1000) - 60, "this print");
  assert.equal(fresh.stale, false);
  assert.equal(fresh.note, undefined, "a fresh print needs no explanation");
});

test("days, not hours, once a reading is properly dead", () => {
  /* THE MEASURED CASE. The testnet press's prints were 25.05 days old on
     2026-10-10 (posted_at 1789450387). The terminal's `ageWords` tops out at
     `hr ago` and rendered that as "601 hr ago" — true, and useless to an agent
     with no prior that the print is hourly. */
  assert.equal(ageWords(25.05 * 86400), "25.1 days ago");
  assert.equal(ageWords(null), "age unknown");
  assert.equal(ageWords(30), "just now");
  assert.equal(ageWords(1800), "30 min ago");
  assert.equal(ageWords(6 * 3600), "6 hr ago");
  // The handover from hours to days, asserted so neither side of 48h is a gap.
  assert.match(ageWords(47 * 3600), /hr ago$/);
  assert.match(ageWords(49 * 3600), /days ago$/);
});

test("the overdue sentence names the press's own boundary", () => {
  /* Not a boundary invented here: /ops renders "past the settle window" from
     the same constant, and two surfaces must not offer a reader two different
     reasons for the same verdict. */
  const s = staleness(Math.floor(Date.now() / 1000) - 25 * 86400, "this print");
  assert.equal(s.stale, true);
  assert.equal(s.freshness, "overdue");
  assert.match(String(s.note), /past the settle window/);
  assert.match(String(s.note), /last known value/);
  assert.match(String(s.note), /25\.0 days ago/);
});

test("the subject is named, so one sentence serves both tools", () => {
  /* `get_rate` goes stale because an oracle stopped; `check_spend` goes stale
     because a market fetch did. Same mechanism, different noun. */
  const old = Math.floor(Date.now() / 1000) - 10 * 86400;
  assert.match(String(staleness(old, "the market basket").note), /^the market basket is/);
  assert.match(String(staleness(old, "this print").note), /^this print is/);
});
