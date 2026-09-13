import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUCKETS, MIN_RATED_N, bp, bpFromWeighted, bucketBars, bucketTotal, byWorstFirst, gradeOf, humanCell, humanShareInWindow, sellersFromSettlements, usdc6, wad18, followedReroute, recentForPayer } from "./tape";

const REPO = join(__dirname, "..", "..", "..");

test("volume-weighted slippage uses the one correct reduction", () => {
  /* wSlipTenthBp is a PRODUCT — sum(amount x slippageTenthBp) — not a rate.
     These are the real numbers the live subgraph published for the three
     mirrored settlements, hand-checked in docs/SPIKE-LOG.md. */
  // amount is USDC 1e6 (0.005229 USDC -> 5229) and slippageTenthBp is bp x 10.
  assert.equal(Math.round(bpFromWeighted(5229 * 6471, 5229)! * 10) / 10, 647.1);
  assert.equal(Math.round(bpFromWeighted(5101 * 3865, 5101)! * 10) / 10, 386.5);
  assert.equal(Math.round(bpFromWeighted(3718 * -8362, 3718)! * 10) / 10, -836.2);

  // The three ways to get it wrong, each of which returns a plausible number.
  const w = 5229 * 6471;
  const v = 5229;
  assert.notEqual(w / 1e6, bpFromWeighted(w, v));
  assert.notEqual(w / 10, bpFromWeighted(w, v));
  assert.notEqual(w / v, bpFromWeighted(w, v));

  // Decimal strings, which is how The Graph actually serialises BigInt.
  assert.equal(bpFromWeighted(String(w), String(v)), bpFromWeighted(w, v));
});

test("no benchmarked volume is an absence, never a zero", () => {
  // The distinction the whole tape rests on: "no print preceded this trade" is
  // not "this trade was priced perfectly".
  assert.equal(bpFromWeighted(0, 0), null);
  assert.equal(bpFromWeighted(1234, 0), null);
  assert.equal(bpFromWeighted(1234, -1), null);
  assert.equal(bpFromWeighted(null, 500), null);
  assert.equal(bpFromWeighted(undefined, undefined), null);
  assert.equal(bpFromWeighted("not-a-number", 500), null);
  // And a genuine zero survives as a zero.
  assert.equal(bpFromWeighted(0, 5_000_000), 0);
});

test("the two scales stay apart", () => {
  assert.equal(usdc6(5_229_000), 5.229); // USDC 1e6
  assert.equal(usdc6("3718"), 0.003718);
  assert.equal(wad18("499100667013303552"), 0.4991006670133036); // WAD 1e18
  assert.equal(usdc6(null), null);
  assert.equal(wad18(""), null);
  // A WAD value read as USDC is off by twelve orders of magnitude — the class of
  // bug that mis-bills a reader under a live number.
  assert.notEqual(usdc6("499100667013303552"), wad18("499100667013303552"));
});

test("the histogram counts benchmarked settlements, not purchases", () => {
  // sum(b0..b6) === n, never nAll. An unbenchmarked settlement fires no bucket
  // (graph/src/rollup.ts), so a caller labelling this total "purchases" is
  // mislabelling it.
  const row = { b0: 1, b1: 0, b2: 0, b3: 0, b4: 0, b5: 1, b6: 1 };
  assert.equal(bucketTotal(row), 3);
  assert.equal(bucketTotal(null), 0);

  const bars = bucketBars(row);
  assert.equal(bars.length, 7);
  assert.equal(bars.reduce((s, b) => s + b.frac, 0), 1);
  // An empty row must not divide by zero into NaN bars.
  assert.ok(bucketBars(null).every((b) => b.frac === 0 && b.n === 0));
});

test("the bucket edges match the mapping that fills them", () => {
  /* Same discipline as chain.test.ts: the axis labels on this page are a copy
     of boundaries that live in AssemblyScript. Reorder those and nothing here
     throws — the bars just land under the wrong labels, under a live badge. */
  const src = readFileSync(join(REPO, "graph", "src", "tca.ts"), "utf8");
  const fn = src.slice(src.indexOf("export function bucketOf"));
  const edges = [...fn.matchAll(/if \(v < (-?\d+)\) return \d+;/g)].map((m) => Number(m[1]));
  assert.deepEqual(edges, [-100, 0, 50, 100, 200, 500], "graph/src/tca.ts bucketOf has moved");

  // Our labels must describe exactly those half-open ranges, in order.
  assert.deepEqual(
    BUCKETS.map((b) => b.hi),
    [...edges, null],
  );
  assert.deepEqual(
    BUCKETS.map((b) => b.lo),
    [null, ...edges],
  );
});

test("the grade thresholds match the service that publishes them", () => {
  const py = readFileSync(
    join(REPO, "services", "index_api", "index_api", "tca.py"),
    "utf8",
  );
  const cuts = [...py.matchAll(/if score >= ([\d.]+):\s*\n\s*return "([ABCD])"/g)].map((m) => [
    Number(m[1]),
    m[2],
  ]);
  assert.deepEqual(cuts, [[0.85, "A"], [0.7, "B"], [0.5, "C"]], "tca.py _grade has moved");

  for (const [cut, letter] of cuts as [number, string][]) {
    assert.equal(gradeOf(cut), letter, `${cut} should grade ${letter}`);
  }
  assert.equal(gradeOf(0.8499), "B"); // just below A
  assert.equal(gradeOf(0.6999), "C"); // just below B
  assert.equal(gradeOf(0.4999), "D"); // just below C
  assert.equal(gradeOf(1), "A");
  // An absent score is Unrated, never a D. Not scoring is not scoring badly.
  assert.equal(gradeOf(null), "Unrated");
  assert.equal(gradeOf(undefined), "Unrated");
  assert.equal(gradeOf(NaN), "Unrated");

  const m = py.match(/MIN_RATED_N\s*=\s*(\d+)/);
  assert.ok(m, "tca.py should declare MIN_RATED_N");
  assert.equal(MIN_RATED_N, Number(m![1]), "MIN_RATED_N has drifted from tca.py");
});

test("sellers read worst-first, and the unpriced sink", () => {
  const rows = [
    { seller: "b", vw_slippage_bp: 386.5 },
    { seller: "unpriced", vw_slippage_bp: null },
    { seller: "a", vw_slippage_bp: 647.1 },
    { seller: "c", vw_slippage_bp: -836.2 },
  ];
  assert.deepEqual(
    byWorstFirst(rows).map((r) => r.seller),
    ["a", "b", "c", "unpriced"],
  );
  // Pure: the caller's array is not reordered under it.
  assert.equal(rows[0].seller, "b");
});

test("basis points carry their sign, and absence prints as absence", () => {
  assert.equal(bp(647.1), "+647 bp");
  assert.equal(bp(-836.2), "-836 bp");
  assert.equal(bp(0), "0 bp");
  assert.equal(bp(647.14, 1), "+647.1 bp");
  // Never the string "NaN" on a page, and never a bare 0 for "we do not know".
  assert.equal(bp(null), "…");
  assert.equal(bp(undefined), "…");
  assert.equal(bp(NaN), "…");
});


test("the seller directory can be grouped out of raw settlements", () => {
  /* The `sellers` operation is the right source; this is the fallback for when
     it cannot answer. A page that dies because one operation grew a field is a
     brittle page — and that is not hypothetical, `sellers` gained a relation the
     deployed subgraph does not carry and returned nothing at all. */
  const rows = [
    { seller: { id: "0xa" }, payer: { id: "0xp1" }, amount: 1000, slippageBp: 600, benchmarked: true, synthetic: true, human: false },
    // One human-backed fill: the payer had a cluster for the window it landed in.
    { seller: { id: "0xa" }, payer: { id: "0xp2" }, amount: 3000, slippageBp: 200, benchmarked: true, synthetic: false, human: true },
    // Unbenchmarked: counted in volume and in the fill count, but it must not
    // reach the weighted average — "we could not measure it" is not "0 bp".
    { seller: { id: "0xa" }, payer: { id: "0xp1" }, amount: 9000, slippageBp: null, benchmarked: false, synthetic: false },
    { seller: { id: "0xb" }, payer: { id: "0xp1" }, amount: 500, slippageBp: -800, benchmarked: true, synthetic: false },
  ];
  const [a, b] = sellersFromSettlements(rows).sort((x, y) => (x.id < y.id ? -1 : 1));

  assert.equal(a.id, "0xa");
  assert.equal(a.settlementCount, 3, "every settlement counts as a fill");
  assert.equal(a.totalVolume, 13_000, "volume includes the unpriced one");
  assert.equal(a.benchmarkedVolume, 4_000, "measured volume does not");
  assert.equal(a.distinctPayers, 2);
  // (1000*600 + 3000*200) / 4000 = 300. The unpriced 9000 would have dragged
  // this to 92 if it had been folded in as a zero.
  assert.equal(a.vw_slippage_bp, 300);
  assert.equal(a.syntheticShare, 1000 / 13_000);
  // The same fold, for people: 3000 of 13_000 came from a wallet the chain ties
  // to a person. A row with no `human` field at all folds as false, never true.
  assert.equal(a.humanShare, 3000 / 13_000);
  assert.equal(b.humanShare, 0);

  assert.equal(b.vw_slippage_bp, -800);
  assert.equal(b.distinctPayers, 1);
});

test("a seller with nothing measurable has no average, not a zero", () => {
  const [only] = sellersFromSettlements([
    { seller: { id: "0xa" }, payer: { id: "0xp" }, amount: 100, slippageBp: null, benchmarked: false, synthetic: false },
  ]);
  assert.equal(only.vw_slippage_bp, null);
  assert.equal(only.benchmarkedVolume, 0);
  assert.equal(only.settlementCount, 1);
});

test("settlements with no seller are skipped, not grouped under undefined", () => {
  const out = sellersFromSettlements([
    { seller: null, payer: { id: "0xp" }, amount: 100, slippageBp: 10, benchmarked: true, synthetic: false },
  ]);
  assert.deepEqual(out, []);
  assert.deepEqual(sellersFromSettlements([]), []);
});


/* --- human depth: a count, or the press's reason for there not being one -----

   Measured against the live press rather than inferred from the branch: the
   `human_depth` key is ALWAYS present. tca.py has an `else` that reports
   available:false with "no human resolutions on the tape for this window", so an
   earlier version of this model had a third state for an absent key that never
   fires, and the label on the state that DOES fire was wrong. */

test("the live state today: a reason, carried verbatim, never a zero", () => {
  // Exactly what /rating returns for every seller right now — the four demo
  // wallets are resolved on chain but none has settled.
  const cell = humanCell({
    available: true,
    components: {
      human_depth: {
        available: false,
        reason: "no human resolutions on the tape for this window",
      },
    },
  });
  assert.deepEqual(cell, {
    kind: "unmeasured",
    note: "no human resolutions on the tape for this window",
  });
});

test("an over-long window is the press's distinction to draw, not ours", () => {
  const cell = humanCell({
    available: true,
    components: {
      human_depth: { available: false, reason: "cannot be summed across windows" },
    },
  });
  // The note is the upstream string untouched. Re-phrasing it here is how a
  // surface starts disagreeing with the service behind it.
  assert.equal(cell.kind === "unmeasured" && cell.note, "cannot be summed across windows");
});

test("a present-but-zero count is not a count", () => {
  // "0 people" claims we looked and found nobody. Declining to measure is a
  // different fact, and this is the cell where they would merge.
  const cell = humanCell({
    available: true,
    components: { human_depth: { available: true, distinct_humans: 0, distinct_payers: 3 } },
  });
  assert.equal(cell.kind, "unmeasured");
});

test("no component at all still renders, with a stated fallback", () => {
  assert.equal(humanCell(undefined).kind, "unmeasured");
  assert.equal(humanCell({ available: true }).kind, "unmeasured");
  assert.equal(humanCell({ available: true, components: {} }).kind, "unmeasured");
});

test("a real count carries its payers and whether every one is sandbox", () => {
  assert.deepEqual(
    humanCell({
      available: true,
      components: {
        human_depth: { available: true, distinct_humans: 2, distinct_payers: 5, sandbox_humans: 2 },
      },
    }),
    { kind: "count", humans: 2, payers: 5, allSandbox: true },
  );

  const mixed = humanCell({
    available: true,
    components: {
      human_depth: { available: true, distinct_humans: 3, distinct_payers: 4, sandbox_humans: 1 },
    },
  });
  assert.equal(mixed.kind === "count" && mixed.allSandbox, false);
});

test("a count with no payer figure is still a count, with payers null", () => {
  assert.deepEqual(
    humanCell({
      available: true,
      components: { human_depth: { available: true, distinct_humans: 1 } },
    }),
    { kind: "count", humans: 1, payers: null, allSandbox: false },
  );
});

test("a seller's human share is read off ONE window, and an unmeasured window is null", () => {
  /* `humanVolume` is per window because a cluster is minted per window. Summing
     across windows would credit last week's people to this week's volume, and a
     window with no volume is "not measured", which must not render as "no humans". */
  const windows = [
    { window: "2957", volume: 4000, humanVolume: 4000 },
    { window: "2958", volume: 10_000, humanVolume: 2500 },
    { window: "2959", volume: 0, humanVolume: 0 },
  ];
  assert.equal(humanShareInWindow(windows, 2958), 0.25);
  assert.equal(humanShareInWindow(windows, 2957), 1);
  assert.equal(humanShareInWindow(windows, 2959), null, "no volume yet is not measured");
  assert.equal(humanShareInWindow(windows, 2960), null, "a window with no rollup at all");
  assert.equal(humanShareInWindow(undefined, 2958), null);
});


test("the payer's newest purchases come off the settlements the route already holds", () => {
  const row = (payer: string, seller: string, at: number) => ({
    seller: { id: seller }, payer: { id: payer }, amount: "100000", slippageBp: "10",
    benchmarked: true, synthetic: false, human: true, settledAt: String(at),
  });
  const rows = [
    row("0xME", "0xA", 100), row("0xme", "0xB", 300), row("0xother", "0xA", 400),
    row("0xme", "0xC", 200), { ...row("0xme", "0xD", 500), seller: null },
  ];
  const recent = recentForPayer(rows, "0xME", 2);
  assert.deepEqual(recent.map((r) => [r.seller, r.settledAt]), [["0xb", 300], ["0xc", 200]]);
  assert.equal(recent[0].amountUsdc, 0.1);
  assert.equal(recent[0].human, true);
  assert.deepEqual(recentForPayer(rows, null), []);
});

test("whether the buyer acted is read off the newest purchase, never assumed", () => {
  const rr = { from: "0xWORST", to: "0xBEST" };
  const at = (seller: string) => [{ seller, settledAt: 1, amountUsdc: 0.1, human: false }];
  assert.equal(followedReroute(at("0xbest"), rr), "followed");
  assert.equal(followedReroute(at("0xworst"), rr), "ignored");
  assert.equal(followedReroute(at("0xelse"), rr), "elsewhere");
  assert.equal(followedReroute([], rr), "none");
  assert.equal(followedReroute(at("0xbest"), null), "none");
});
