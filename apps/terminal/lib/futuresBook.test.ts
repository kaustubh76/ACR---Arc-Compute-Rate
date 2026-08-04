import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  basisBp,
  completeHistory,
  contractNotional,
  deskIndexPhrase,
  deskTier,
  expiryLabel,
  formatOi,
  formatQty,
  headroomBar,
  markSeries,
  newestFillSince,
  onchainTier,
  tapeAge,
} from "./futuresBook";
import fallback from "./fallback.json";
import type { FuturesTradeRow } from "./types";

const TAPE = fallback.futures_trades as FuturesTradeRow[];

test("a fractional fill keeps its size — the tape said BUY 0 for a real trade", () => {
  // The defect, pinned. These are the actual qty values on the venue's tape.
  assert.equal(formatQty(0.25), "0.25");
  assert.equal(formatQty(0.81), "0.81");
  assert.equal(formatQty(-1), "1"); // sign is carried by the BUY/SELL word
  assert.equal(formatQty(1), "1"); // an integer stays bare
  assert.equal(formatQty(2), "2");
  assert.equal(formatQty(1.5), "1.50");
  assert.equal(formatQty(0), "0");
  // Smaller than a hundredth of a contract: say so rather than round to the
  // zero that started this.
  assert.equal(formatQty(0.004), "<0.01");
  assert.equal(formatQty(Number.NaN), "0");
});

test("every real fill on the archived tape renders as a non-zero size", () => {
  // The regression in its natural habitat: run the formatter over the venue's
  // own 23 fills and assert none of them disappears.
  assert.ok(TAPE.length > 0, "the bundle should carry a tape");
  for (const t of TAPE) {
    assert.notEqual(formatQty(t.qty), "0", `fill ${t.tx} rendered as zero`);
  }
});

test("a contract is worth mark x multiplier, and nothing when either is missing", () => {
  // The live series: multiplier 10 at a mark near 0.4953 -> about $4.95.
  const n = contractNotional(0.4953335, 10);
  assert.ok(n !== null);
  assert.ok(Math.abs(n - 4.953335) < 1e-9);
  // Never a confident zero: a caller must pick a sentence with no figure in it.
  assert.equal(contractNotional(0.5, 0), null);
  assert.equal(contractNotional(0, 10), null);
  assert.equal(contractNotional(Number.NaN, 10), null);
});

test("no surface re-authors the $1,000 contract size", () => {
  // The mistake was copying an EXAMPLE out of a contract comment
  // (ACRFutures.sol:84, "e.g. 1000") and stating it as fact in both editions.
  // Deriving it from `multiplier` fixes today; this stops it being retyped.
  const ROOT = join(__dirname, "..");
  const tsx = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...tsx(p));
      else if (e.name.endsWith(".tsx")) out.push(p);
    }
    return out;
  };
  const BANNED = /1,?000 (USDC )?a unit|\$1,000 a (unit|contract)/i;
  const offenders = [...tsx(join(ROOT, "app")), ...tsx(join(ROOT, "components"))]
    .filter((f) => BANNED.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f));
  assert.deepEqual(offenders, [], `contract size must come from desk.multiplier: ${offenders}`);
});

test("an expiry is a real date, in UTC, the same on server and client", () => {
  // The live series' real expiry, cross-checked against python's
  // datetime.fromtimestamp(..., timezone.utc). Unlike a print's ts
  // (SIM-seconds), expiry_ts is genuine epoch, so a date here is honest.
  assert.equal(expiryLabel(1786972818), "Aug 17, 2026 · 13:20 UTC");
  assert.equal(expiryLabel(0), "—");
});

test("basis is the gap to the rate the contract settles against", () => {
  const bp = basisBp(0.4953335, 0.4923551);
  assert.ok(bp !== null);
  assert.ok(Math.abs(bp - 60.49) < 0.5, `expected ~+60bp, got ${bp}`);
  assert.ok((basisBp(0.49, 0.5) ?? 0) < 0, "trading below the oracle is negative basis");
  assert.equal(basisBp(0.5, 0), null);
});

test("the chart series is one series, deduped, and runs oldest-first by block", () => {
  const rows = markSeries(TAPE, 3);
  assert.ok(rows.length > 1, "series 3 should have fills");
  assert.ok(
    rows.every((r) => r.series_id === 3),
    "no foreign series",
  );
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].block >= rows[i - 1].block, "blocks must ascend");
  }
  // Sorting by block rather than seen_at is load-bearing: in the archived
  // bundle every trade shares one seen_at (the snapshot stamp), so a
  // wall-clock sort would collapse the series into a single column.
  assert.equal(new Set(TAPE.map((t) => t.seen_at)).size, 1);
  assert.ok(new Set(TAPE.map((t) => t.block)).size > 1);
  assert.deepEqual(markSeries(TAPE, 999), []);
});

test("a repeated tx is one fill", () => {
  const one = TAPE[0];
  assert.equal(markSeries([one, { ...one }], one.series_id).length, 1);
});

test("the desk says which tier served it, and absent is not archived", () => {
  assert.equal(deskTier("chain", true).chip, "chip-gold");
  assert.equal(deskTier("press", true).chip, "chip-teal");
  assert.equal(deskTier("bundle", false).chip, "chip-sim");
  // An older proxy omits `source`. Missing is not evidence of an archive —
  // defer to the envelope, which is the thing that actually knows.
  assert.equal(deskTier(undefined, true).chip, "chip-teal");
  assert.equal(deskTier(undefined, false).chip, "chip-sim");
});

test("a receipt is only this trade's, never the last one that happened to be there", () => {
  const a = { ...TAPE[0], tx: "0xaaa", block: 10 } as FuturesTradeRow;
  const b = { ...TAPE[0], tx: "0xbbb", block: 11 } as FuturesTradeRow;
  // Nothing new since the trade started: a quiet desk must not hand back a
  // stale hash and call it a receipt.
  assert.equal(newestFillSince("0xbbb", [a, b]), null);
  assert.equal(newestFillSince("0xaaa", [a]), null);
  assert.equal(newestFillSince("0xaaa", [a, b])?.tx, "0xbbb");
  // A reader's very first fill has no "before".
  assert.equal(newestFillSince(null, [a, b])?.tx, "0xbbb");
  assert.equal(newestFillSince(null, []), null);
});

test("book capacity draws both sides, and names a frozen one", () => {
  const full = headroomBar(2, 2);
  assert.deepEqual(full, { buyPct: 100, sellPct: 100, frozen: false });
  // The real regression: the maker drifted short 2.31 against a 2.26 cap, so
  // max_buy went to 0 and every buy reverted for eleven hours while the page
  // still looked healthy. A shut side must be able to say so.
  assert.equal(headroomBar(0, 2).frozen, true);
  assert.equal(headroomBar(2, 0).frozen, true);
  assert.equal(headroomBar(1.47, 2).buyPct, 73.5);
  assert.equal(headroomBar(9, 9).buyPct, 100, "clamped at the cap the desk applies");
  assert.equal(headroomBar(Number.NaN, 2).frozen, true);
});

test("open interest reads the same on every surface", () => {
  // The home page and the dateline printed toFixed(0) while the desk printed
  // toFixed(1), so 2.82 was "3 contracts open" on one page and "2.8" on
  // another. One function, so they cannot drift apart again.
  assert.equal(formatOi(2.82), "2.8");
  assert.equal(formatOi(2.31), "2.3");
  assert.equal(formatOi(0), "0.0");
  assert.equal(formatOi(-2.82), "2.8", "open interest is a magnitude");
  assert.equal(formatOi(Number.NaN), "0.0");
});

test("the copy names the indices that actually have books", () => {
  assert.equal(deskIndexPhrase(["ACR-INF"]), "on ACR-INF");
  assert.equal(deskIndexPhrase(["ACR-INF", "ACR-GPU"]), "on ACR-GPU and ACR-INF");
  assert.equal(deskIndexPhrase(["ACR-INF", "ACR-GPU", "ACR-DATA"]), "on all 3 indices");
  assert.equal(deskIndexPhrase(["ACR-INF", "ACR-INF"]), "on ACR-INF", "deduped");
  assert.equal(deskIndexPhrase([]), "");
});

test("an archived fill does not pretend to have a live age", () => {
  // Every archived row shares one seen_at (the snapshot stamp), so a ticking
  // age says the same wrong number on all 23 of them and drifts further every
  // hour the bundle sits.
  assert.deepEqual(tapeAge(1785779305, 1785839259, "bundle"), { text: "archived", live: false });
  assert.equal(tapeAge(1785839200, 1785839259, "press").text, "59s ago");
  assert.equal(tapeAge(1785839259 - 600, 1785839259, "chain").text, "10m ago");
  assert.equal(tapeAge(1785839259 - 7200, 1785839259, "press").text, "2h ago");
  // Before the shared clock starts there is no age to state.
  assert.equal(tapeAge(1785839200, 0, "press").text, "");
});

test("a direct history is published only when it is complete", () => {
  // A dropped row left no hole — the chart scales by ordinal, so it drew a
  // confident continuous line through the missing print.
  assert.deepEqual(completeHistory([1, 2, 3], 3), [1, 2, 3]);
  assert.equal(completeHistory([1, 2], 3), null, "a short series must not publish");
  assert.equal(completeHistory([], 0), null);
});

test("a partial crawl is its own answer, not a full one", () => {
  assert.equal(onchainTier(3, 3), "full");
  assert.equal(onchainTier(2, 3), "partial");
  assert.equal(onchainTier(0, 3), "none");
});

test("a receipt is never minted from a read that failed", () => {
  const a = { ...TAPE[0], tx: "0xaaa", block: 10 } as FuturesTradeRow;
  // undefined = the read failed. Previously an unreadable "before" collapsed
  // to null and handed back whatever was newest — a PREVIOUS trade, shown as
  // the receipt for the one just made.
  assert.equal(newestFillSince(undefined, [a]), null);
  assert.equal(newestFillSince(null, undefined), null);
  assert.equal(newestFillSince(undefined, undefined), null);
});
