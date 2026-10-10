import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ageWords,
  ANCHOR_MAX_AGE_S,
  basketStaleness,
  PRINT_MAX_AGE_S,
  PRINT_WARN_AGE_S,
  printFreshness,
  printStaleness,
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
const PAR_PY = join(
  __dirname, "..", "..", "services", "index_api", "index_api", "par.py",
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
  assert.equal(printStaleness(null).stale, false, "unknown must not assert staleness");
  assert.match(String(printStaleness(null).note), /carried no timestamp/);
});

test("the age is only said when it is news", () => {
  assert.equal(worthSaying("fresh"), false);
  assert.equal(worthSaying("late"), true);
  assert.equal(worthSaying("overdue"), true);
  // A fresh reading gets the fields and no sentence: the numbers are there for
  // a caller who wants them, the prose is reserved for something to act on.
  const fresh = printStaleness(Math.floor(Date.now() / 1000) - 60);
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
  const s = printStaleness(Math.floor(Date.now() / 1000) - 25 * 86400);
  assert.equal(s.stale, true);
  assert.equal(s.freshness, "overdue");
  assert.match(String(s.note), /past the settle window/);
  assert.match(String(s.note), /last known value/);
  assert.match(String(s.note), /25\.0 days ago/);
});

test("the basket's window is the press's, and is NOT the print's", () => {
  /* THE BUG THIS FILE NOW GUARDS. There used to be one `staleness(stamp, what)`
     with one pair of thresholds, where the only thing a caller chose was a noun
     — so `check_spend`'s market basket was judged against the venue's settle
     window and a basket 4.07 days old reported "overdue, past the settle window
     (2 hr)". The press disagrees by a factor of 360. */
  const src = readFileSync(PAR_PY, "utf8");
  const m = /ANCHOR_MAX_AGE_S\s*=\s*float\(os\.environ\.get\("[^"]+",\s*str\(([^)]+)\)\)\)/.exec(src);
  assert.ok(m, "par.py should still declare ANCHOR_MAX_AGE_S");
  // `30 * 86_400` as written there, evaluated rather than restated.
  const declared = Number(m[1].replace(/_/g, "").split("*").reduce((a, b) => String(Number(a) * Number(b))));
  assert.equal(ANCHOR_MAX_AGE_S, declared, "the anchor window drifted from the press's");
  assert.notEqual(
    ANCHOR_MAX_AGE_S,
    PRINT_MAX_AGE_S,
    "a price list and an oracle print do not go stale on the same clock; " +
      "collapsing these back into one pair is what produced the false alarm",
  );
});

test("a four-day basket is not stale, because the press says it is not", () => {
  /* The exact false alarm, asserted so it cannot come back. 4.07 days was the
     measured age of the testnet basket when `/par` reported `status: "ok"`. */
  const fourDays = Math.floor(Date.now() / 1000) - Math.round(4.07 * 86400);
  const r = basketStaleness(fourDays, "ok");
  assert.equal(r.stale, false);
  assert.equal(r.status, "ok");
  assert.match(String(r.age), /days ago/, "the age is still reported — it is a fact either way");
  assert.equal(r.note, undefined, "nothing to act on, so nothing said");
});

test("the press's refusal is passed through, not re-derived", () => {
  /* A basket can be ABSENT or NO_ROWS at any age, and neither is staleness. The
     press computed the verdict against its own window and its own rows; this
     reports it and points at the field that says what answered instead. */
  const young = Math.floor(Date.now() / 1000) - 60;
  const stale = basketStaleness(young, "STALE");
  assert.equal(stale.stale, true, "the press's STALE wins over a young timestamp");
  assert.match(String(stale.note), /reports this basket as STALE/);
  assert.match(String(stale.note), /benchmarked_against/);

  for (const refusal of ["ABSENT", "NO_ROWS"]) {
    const r = basketStaleness(young, refusal);
    assert.equal(r.stale, false, `${refusal} is not staleness`);
    assert.match(String(r.note), new RegExp(refusal));
  }
});

test("without a press verdict the anchor window is the fallback", () => {
  /* Reached only on a press too old to send `basket.status` — the same
     deployment-skew case `check_spend` already handles for a press with no
     /par at all. */
  const now = Math.floor(Date.now() / 1000);
  assert.equal(basketStaleness(now - (ANCHOR_MAX_AGE_S - 1), undefined).stale, false);
  assert.equal(basketStaleness(now - (ANCHOR_MAX_AGE_S + 1), undefined).stale, true);
  assert.match(
    String(basketStaleness(now - (ANCHOR_MAX_AGE_S + 1), undefined).note),
    /refreshed by hand/,
    "the actionable fact is that --fetch is manual, not that a venue cannot settle",
  );
  // And a basket with no stamp at all is not an accusation.
  const undated = basketStaleness(null, "ok");
  assert.equal(undated.stale, false);
  assert.match(String(undated.note), /carried no timestamp/);
});
