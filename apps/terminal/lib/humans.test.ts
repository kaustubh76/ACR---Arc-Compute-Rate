import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RATING_WINDOW_DAYS, RATING_WINDOW_S, countHumans, currentWindow } from "./humans";

/* Solidity time units, so `7 days` is read the way the contract reads it.
   The same table `tests/test_human_window_parity.py` uses. */
const UNITS: Record<string, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
  weeks: 604800,
};

test("the rotation window matches the contract that mints the ids", () => {
  /* THE LOAD-BEARING ASSERTION OF THIS FILE.

     lib/humans.ts is the fourth implementation of one number. The other three —
     HumanIdMirror.sol, graph/src/parties.ts, index_api.tca — are already pinned
     to each other by tests/test_human_window_parity.py, which reads each off
     disk rather than restating it. This joins the fourth to the same chain.

     Drift here does not throw. The strip asks for clusters in a window nobody
     minted ids for, gets none, and the footer reports that the benchmark is
     secured by nobody — under a live block number that makes it look checked.
     A silent zero is the one answer a benchmark must never give by accident.

     Same discipline as MAX_SETTLE_AGE_S in chain.test.ts, for the same reason. */
  const sol = readFileSync(
    join(__dirname, "..", "..", "..", "contracts", "src", "HumanIdMirror.sol"),
    "utf8",
  );
  const m = sol.match(/uint64\s+public\s+constant\s+RATING_WINDOW\s*=\s*(\d+)\s*(\w+)?\s*;/);
  assert.ok(m, "HumanIdMirror.sol should declare RATING_WINDOW");
  const unit = m![2] ?? "seconds";
  assert.ok(unit in UNITS, `unhandled Solidity time unit ${unit}`);
  assert.equal(
    RATING_WINDOW_S,
    Number(m![1]) * UNITS[unit],
    "lib/humans.ts RATING_WINDOW_S has drifted from HumanIdMirror.sol",
  );

  // The window is quoted to readers in days on both surfaces. A window that did
  // not divide evenly would make "7 days" a rounding rather than a fact.
  assert.equal(RATING_WINDOW_S % 86400, 0);
  assert.equal(RATING_WINDOW_DAYS, RATING_WINDOW_S / 86400);
});

test("the window comes from the time it is handed, not a clock", () => {
  // Boundaries, because that is where a browser clock a few minutes fast would
  // disagree with chain time and look for ids in a window that does not exist.
  assert.equal(currentWindow(0), 0);
  assert.equal(currentWindow(RATING_WINDOW_S - 1), 0);
  assert.equal(currentWindow(RATING_WINDOW_S), 1);
  assert.equal(currentWindow(2957 * RATING_WINDOW_S + 5), 2957);
});

const row = (
  id: string,
  window: number,
  sandbox = true,
  walletCount = 1,
  settlements: number[] = [],
) => ({
  id,
  window: String(window),
  sandbox,
  walletCount,
  wallets: settlements.map((n, i) => ({ id: `${id}-w${i}`, settlementCount: String(n) })),
});

test("humans are counted in one window, never summed across them", () => {
  /* The whole safety of the count. A cluster id is minted per window, so one
     person carries a different id in each; adding two windows together turns
     one human into two. tca.py refuses a longer request rather than serving a
     blended number, and the `humans` operation returns EVERY window it has
     indexed, so this filter is what keeps the strip's N honest. */
  const rows = [
    row("0xaaa", 2957),
    row("0xbbb", 2957),
    // The same two people, last window. Counting these would double N.
    row("0xccc", 2956),
    row("0xddd", 2956),
  ];
  assert.equal(countHumans(rows, 2957)!.n, 2);
  assert.equal(countHumans(rows, 2956)!.n, 2);
  // A window nobody has resolved yet is empty, not an error.
  assert.equal(countHumans(rows, 2958)!.n, 0);
});

test("a duplicate row cannot inflate the count", () => {
  const rows = [row("0xAAA", 2957), row("0xaaa", 2957), row("0xbbb", 2957)];
  assert.equal(countHumans(rows, 2957)!.n, 2);
});

test("wallets are summed but humans are not: a fleet is one person", () => {
  // The Module W claim in one assertion. Four wallets, two humans.
  const rows = [row("0xaaa", 2957, true, 3), row("0xbbb", 2957, true, 1)];
  const got = countHumans(rows, 2957)!;
  assert.equal(got.n, 2);
  assert.equal(got.wallets, 4);
});

test("the Sandbox caveat is driven by the data, never by a constant", () => {
  const allSim = countHumans([row("0xaaa", 1), row("0xbbb", 1)], 1)!;
  assert.equal(allSim.sandbox, 2);
  assert.equal(allSim.allSandbox, true);

  const mixed = countHumans([row("0xaaa", 1), row("0xbbb", 1, false)], 1)!;
  assert.equal(mixed.sandbox, 1);
  assert.equal(
    mixed.allSandbox,
    false,
    "one Orb-verified human means the count is no longer wholly simulated",
  );
});

test("an empty window is not 'every one of nobody is simulated'", () => {
  const empty = countHumans([], 2957)!;
  assert.equal(empty.n, 0);
  assert.equal(empty.allSandbox, false, "a caveat about nobody is not a claim worth rendering");
});

test("an unread tape is null, never zero", () => {
  /* The rule the whole feature turns on. `null` means the press did not answer;
     `{n: 0}` means it answered and nobody is verified. Rendering them the same
     is how a dashboard starts lying, and it is the same verdict OpsCheck.ok
     already encodes as first-class. */
  assert.equal(countHumans(null, 2957), null);
  assert.equal(countHumans(undefined, 2957), null);
  assert.notEqual(countHumans([], 2957), null);
});

test("resolved is not the same as securing anything", () => {
  /* The distinction the whole claim rests on, and the one a reader is most
     likely to have blurred for them. A human who registered a wallet with World
     and never traded contributes no observation to the tape, so the
     manipulation bound cannot be denominated in them.

     It is also what keeps this surface honest against /tape, which counts
     humans who TRADED with a given seller. Reporting "secured by 2" here while
     that page reports none would be two surfaces contradicting each other about
     the same fact — worse than either number on its own. */
  const rows = [
    row("0xaaa", 2957, true, 3, [0, 0, 0]), // resolved, never traded
    row("0xbbb", 2957, true, 1, [4]), //       resolved and trading
  ];
  const got = countHumans(rows, 2957)!;
  assert.equal(got.n, 2, "both are resolved");
  assert.equal(got.traded, 1, "only one has settled anything");
});

test("one wallet settling is enough to make the human count as trading", () => {
  // Requiring every wallet would undercount the human exactly where the fleet
  // story is strongest: the point of a fleet is that purchases are spread out.
  const got = countHumans([row("0xaaa", 1, true, 3, [0, 7, 0])], 1)!;
  assert.equal(got.traded, 1);
});

test("a cluster with no wallet rows is resolved but not trading", () => {
  // The live shape today: four demo wallets resolved on chain, none settled.
  // Absent wallet data must not be read as "has traded".
  const got = countHumans([row("0xaaa", 1, true, 1)], 1)!;
  assert.equal(got.n, 1);
  assert.equal(got.traded, 0);
});
