import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  freshnessClock,
  PRINT_MAX_AGE_S,
  PRINT_WARN_AGE_S,
  printFreshness,
  worthSaying,
} from "./printAge";

const OPS_PY = join(
  __dirname, "..", "..", "..", "services", "index_api", "index_api", "ops.py",
);

test("the thresholds are the press's own, read out of ops.py", () => {
  /* A CROSS-LANGUAGE PIN, for the reason lib/chain.test.ts gives about
     SECTIONS: two surfaces answering "is this print late" from two different
     numbers will eventually disagree, and the one a reader sees is the one
     with no reasoning behind it. The press already judges this and says "past
     the settle window"; these constants are that judgement, mirrored.

     Reading the file rather than restating the value is what makes this fail
     when somebody changes ops.py and not this. */
  const src = readFileSync(OPS_PY, "utf8");
  const warn = /PRINT_WARN_AGE_S\s*=\s*float\(os\.environ\.get\("[^"]+",\s*"(\d+)"\)\)/.exec(src);
  const max = /PRINT_MAX_AGE_S\s*=\s*float\(os\.environ\.get\("[^"]+",\s*"(\d+)"\)\)/.exec(src);
  assert.ok(warn, "ops.py should still declare PRINT_WARN_AGE_S");
  assert.ok(max, "ops.py should still declare PRINT_MAX_AGE_S");
  assert.equal(PRINT_WARN_AGE_S, Number(warn[1]));
  assert.equal(PRINT_MAX_AGE_S, Number(max[1]));
});

test("an hourly print inside its window is simply fresh", () => {
  const now = 1_791_000_000;
  assert.deepEqual(printFreshness(now - 600, now), { state: "fresh", ageS: 600 });
  assert.equal(worthSaying("fresh"), false, "forty minutes old is the system working");
});

test("past the warn window it is late, past the settle window it is overdue", () => {
  const now = 1_791_000_000;
  assert.equal(printFreshness(now - (PRINT_WARN_AGE_S + 1), now).state, "late");
  assert.equal(printFreshness(now - (PRINT_MAX_AGE_S + 1), now).state, "overdue");
  // The boundary belongs to the lower state: at exactly the limit, nothing is
  // yet wrong, which is what "past the window" means in the press's wording.
  assert.equal(printFreshness(now - PRINT_WARN_AGE_S, now).state, "fresh");
  assert.equal(printFreshness(now - PRINT_MAX_AGE_S, now).state, "late");
  assert.ok(worthSaying("late") && worthSaying("overdue"));
});

test("the live mainnet state is overdue by a wide margin", () => {
  /* The measurement this file was written for: `posted_at` 1790900060 read at
     2026-10-10, 8.2 days. Not a fixture — the number the production payload
     actually carried while the hero badged it live. */
  const observed = printFreshness(1_790_900_060, 1_790_900_060 + 8.2 * 86_400);
  assert.equal(observed.state, "overdue");
  // 8.2 days / 7200s = 98.4 settle windows. I wrote "a hundred" from memory
  // and the test said no, which is the whole reason the number is here.
  assert.ok((observed.ageS ?? 0) > 98 * PRINT_MAX_AGE_S, "ninety-eight settle windows past");
});

test("no timestamp and no clock are unknown, never fresh", () => {
  /* `useNow()` is 0 during SSR by design, so the first paint cannot tell — and
     an absent answer must not render as a good one. This is the same rule the
     tape's `seen` field exists for, one surface over. */
  assert.equal(printFreshness(undefined, 1_791_000_000).state, "unknown");
  assert.equal(printFreshness(0, 1_791_000_000).state, "unknown");
  assert.equal(printFreshness(1_790_900_060, 0).state, "unknown", "no clock yet");
  assert.equal(worthSaying("unknown"), false, "silence, not a claim either way");
});

test("a clock behind the print does not produce a negative age", () => {
  // Clock skew between a browser and the chain is ordinary; "-3s old" is not.
  const r = printFreshness(1_791_000_100, 1_791_000_000);
  assert.equal(r.ageS, 0);
  assert.equal(r.state, "fresh");
});

test("the hydration frame has a clock, so a stale print cannot flash as live", () => {
  /* THE FLASH, caught in the live DOM on 2026-10-10 by reading the same page
     twice 0.4s apart and getting opposite badges. `useNow()` returns 0 for the
     SSR and hydration frames by design, `printFreshness` correctly calls that
     `unknown` — and `HomeHero`'s badge falls through on `unknown` to its
     unconditional `on-chain · live` chip WITH A BREATHING DOT. So the front
     page claimed a 25-day-old print was live for the whole hydration frame,
     pulsing over a loop that had stopped, which this project elsewhere calls
     the one signal worse than none.
     Neither function was wrong; the WIRING was. The envelope's `fetchedAt` is
     data rather than a wall clock, so it is identical on both sides of
     hydration and cannot reintroduce the mismatch that made `useNow()` return
     0 in the first place. */
  const fetchedAtMs = 1_800_000_000_000;
  const atFetch = Math.floor(fetchedAtMs / 1000);

  assert.equal(freshnessClock(0, fetchedAtMs), atFetch, "no client clock: judge against the envelope");
  const stale = printFreshness(atFetch - 25 * 86400, freshnessClock(0, fetchedAtMs));
  assert.equal(stale.state, "overdue", "a stale print must read stale from the first paint");
  assert.equal(worthSaying(stale.state), true, "…so the badge is qualified, not LIVE");

  // The live clock wins once it exists: the age keeps growing in an open tab.
  assert.equal(freshnessClock(atFetch + 999, fetchedAtMs), atFetch + 999);

  // With neither, still 0 — `unknown`, never a fabricated now.
  assert.equal(freshnessClock(0, undefined), 0);
  assert.equal(freshnessClock(0, 0), 0);
  assert.equal(printFreshness(atFetch, freshnessClock(0, undefined)).state, "unknown");
});

test("the hero asks for that clock rather than the bare one", () => {
  // A source scan, because the defect was in the wiring: both functions
  // behaved exactly as documented.
  const src = readFileSync(join(__dirname, "..", "components", "HomeHero.tsx"), "utf8");
  assert.match(
    src,
    /nowS=\{freshnessClock\(nowS, fetchedAt\)\}/,
    "HomeHero must judge the print against the envelope when the client clock is 0",
  );
});
