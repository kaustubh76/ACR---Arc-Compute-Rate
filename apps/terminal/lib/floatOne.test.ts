import { test } from "node:test";
import assert from "node:assert/strict";

import { COLUMN, firstPaid, heights, onePayment, script } from "./floatOne";
import type { FloatTape, FloatTapeRow, FloatVaultState, FloatWalk } from "./float";

/* The canonical payment's own log positions, from the transaction the
   submission cites: the sleeve delivered at log 30, the seller was paid at 32,
   the receipt was written at 33. Two logs between the pull and the pay, one
   between the pay and the receipt. */
const PULL_IDX = 30;
const PAY_IDX = 32;
const RCPT_IDX = 33;

const paidRow = (over: Partial<FloatTapeRow> = {}): FloatTapeRow => ({
  kind: "paid",
  block: 70_931_234,
  tx: "0x364723c61d77084e180d99aeef088fe266f222b126bc9e7b2ac38de2f6072f9d",
  agent_id: "0xabc",
  index: "0xdef",
  quote_usdc: 1.05525,
  fair_usdc: 1.05,
  premium_bps: 50,
  jit_funded: true,
  ...over,
});

const walkOk = (over: Partial<FloatWalk> = {}): FloatWalk => ({
  status: "ok",
  tx: paidRow().tx,
  block: 70_931_234,
  quote_usdc: 1.05525,
  fair_usdc: 1.05,
  fair_matches: true,
  jit_funded: true,
  verdict: "in_order",
  steps: [
    { n: 1, state: "ok" },
    { n: 2, state: "ok", log_index: PULL_IDX, value_usdc: 0.53025, requested_usdc: 0.53025 },
    { n: 3, state: "ok", log_index: PAY_IDX, value_usdc: 1.05525 },
    { n: 4, state: "ok", log_index: RCPT_IDX, value_usdc: 1.05525 },
  ],
  ...over,
});

const tape = (rows: FloatTapeRow[], over: Partial<FloatTape> = {}): FloatTape => ({ status: "ok", rows, ...over });

test("heights keep the real gaps instead of spacing the logs evenly", () => {
  /* THE WHOLE REASON THIS AXIS EXISTS. 30 -> 32 -> 33 is a gap of two then a
     gap of one, so the pull must sit two thirds of the way below the pay, not
     half. Even spacing would discard the only quantity the axis carries. */
  const h = heights([PULL_IDX, PAY_IDX, RCPT_IDX]);
  assert.equal(h.get(PULL_IDX), 0);
  assert.equal(h.get(PAY_IDX), 2 / 3);
  assert.equal(h.get(RCPT_IDX), 1);
});

test("a single log, or several at one index, cannot express a gap and does not divide by zero", () => {
  assert.equal(heights([7]).get(7), 0);
  assert.equal(heights([4, 4]).get(4), 0);
  assert.equal(heights([]).size, 0);
});

test("only beats with a log get a height", () => {
  /* The ask is an MCP call and the fair check is arithmetic. Neither emits a
     log, so neither may claim a position on an axis of log indices. */
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkOk() });
  assert.equal(r.status, "live");
  if (r.status !== "live") return;
  const by = Object.fromEntries(r.beats.map((b) => [b.key, b]));
  assert.equal(by.ask.height, null);
  assert.equal(by.ask.logIndex, null);
  assert.equal(by.fair.height, null);
  assert.equal(by.fair.logIndex, null);
  assert.equal(by.pull.logIndex, PULL_IDX);
  assert.equal(by.pull.height, 0);
  assert.equal(by.pay.height, 2 / 3);
  assert.equal(by.receipt.height, 1);
});

test("the pull sits below the pay whenever the chain says it did", () => {
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkOk() });
  if (r.status !== "live") throw new Error("expected live");
  const pull = r.beats.find((b) => b.key === "pull");
  const pay = r.beats.find((b) => b.key === "pay");
  assert.ok(pull && pay && pull.height !== null && pay.height !== null);
  assert.ok(pull.height < pay.height, "the shortfall left the venue before the seller was paid");
  assert.equal(r.verdict, "in_order");
});

test("a contradicted order is plotted as it happened, not corrected", () => {
  /* A picture that cannot come out wrong is not evidence. If the chain reports
     the pull after the pay, the scene must show that. */
  const r = onePayment({
    vault: null,
    tape: tape([paidRow()]),
    walk: walkOk({
      verdict: "out_of_order",
      steps: [
        { n: 1, state: "ok" },
        { n: 2, state: "ok", log_index: 40, value_usdc: 0.5 },
        { n: 3, state: "ok", log_index: 32, value_usdc: 1.05525 },
        { n: 4, state: "ok", log_index: 41, value_usdc: 1.05525 },
      ],
    }),
  });
  if (r.status !== "live") throw new Error("expected live");
  const pull = r.beats.find((b) => b.key === "pull")!;
  const pay = r.beats.find((b) => b.key === "pay")!;
  assert.ok(pull.height! > pay.height!);
  assert.equal(r.verdict, "out_of_order");
});

test("an unproven claim is neither proven nor fraud", () => {
  const r = onePayment({
    vault: null,
    tape: tape([paidRow()]),
    walk: walkOk({
      verdict: "unproven",
      steps: [
        { n: 1, state: "ok" },
        { n: 2, state: "bad" },
        { n: 3, state: "ok", log_index: PAY_IDX, value_usdc: 1.05525 },
        { n: 4, state: "ok", log_index: RCPT_IDX, value_usdc: 1.05525 },
      ],
    }),
  });
  if (r.status !== "live") throw new Error("expected live");
  const pull = r.beats.find((b) => b.key === "pull")!;
  assert.equal(pull.state, "bad");
  assert.equal(pull.logIndex, null, "a missing log is an absence, never a zero");
  assert.equal(pull.height, null);
  assert.equal(r.verdict, "unproven");
});

test("an empty window over a treasury that HAS paid is not an idle treasury", () => {
  /* The tape is about ten thousand blocks, roughly seventy-six minutes. A
     vault reporting receipts with no rows in that window means the window was
     short, and saying "no payments" there would be false. */
  const r = onePayment({ vault: { status: "ok", receipts: 2 } as FloatVaultState, tape: tape([]), walk: null });
  assert.equal(r.status, "scripted");
  if (r.status !== "scripted") return;
  assert.equal(r.why, "none-in-window");
});

test("a window that did not reach the start is a short window, whatever the count says", () => {
  const r = onePayment({
    vault: { status: "ok" } as FloatVaultState,
    tape: tape([], { reached_start: false }),
    walk: null,
  });
  if (r.status !== "scripted") throw new Error("expected scripted");
  assert.equal(r.why, "none-in-window", "an unread receipt count must not be read as a zero");
});

test("only a vault reporting zero receipts has never paid", () => {
  const r = onePayment({ vault: { status: "ok", receipts: 0 } as FloatVaultState, tape: tape([], { reached_start: true }), walk: null });
  if (r.status !== "scripted") throw new Error("expected scripted");
  assert.equal(r.why, "none-ever");
});

test("the scripted beats carry the shape and not one figure", () => {
  const beats = script();
  assert.equal(beats.length, 5);
  for (const b of beats) {
    assert.equal(b.valueUsdc, null, `${b.key} must print no number`);
    assert.equal(b.logIndex, null);
    assert.equal(b.height, null);
  }
  assert.deepEqual(beats.map((b) => b.key), ["ask", "fair", "pull", "pay", "receipt"]);
});

test("a tx in hand with no walk yet is reading, not scripted", () => {
  /* Rendering the figureless script here would flash an empty diagram over a
     payment that is one round trip away. */
  assert.equal(onePayment({ vault: null, tape: tape([paidRow()]), walk: null }).status, "reading");
  assert.equal(onePayment({ vault: null, tape: tape([paidRow()]), walk: walkOk(), reading: true }).status, "reading");
});

test("a signed premium survives, and a missing one is not a zero", () => {
  const under = onePayment({ vault: null, tape: tape([paidRow({ premium_bps: -120 })]), walk: walkOk() });
  if (under.status !== "live") throw new Error("expected live");
  assert.equal(under.premiumBps, -120, "a quote below fair is legal");

  const none = onePayment({ vault: null, tape: tape([paidRow({ premium_bps: null })]), walk: walkOk() });
  if (none.status !== "live") throw new Error("expected live");
  assert.equal(none.premiumBps, null);
});

test("an unfound print reads as unknown, never as a mismatch", () => {
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkOk({ fair_matches: null }) });
  if (r.status !== "live") throw new Error("expected live");
  assert.equal(r.fairMatches, null);
});

test("refusals are not walked: they moved nothing, so they have no order", () => {
  const refused: FloatTapeRow = {
    kind: "refused",
    block: 1,
    tx: "0xaa",
    agent_id: "0xabc",
    index: "0xdef",
    quote_usdc: 3,
    fair_usdc: 1,
    premium_bps: 20_000,
    code: 10,
    reason: "quote exceeds ACR fair band",
  };
  assert.equal(firstPaid([refused]), undefined);
  const r = onePayment({ vault: { status: "ok", receipts: 2 } as FloatVaultState, tape: tape([refused]), walk: null });
  assert.equal(r.status, "scripted");
});

test("the agent is never in a column that holds money", () => {
  assert.equal(COLUMN.ask, "agent");
  assert.notEqual(COLUMN.ask, "treasury");
  assert.equal(COLUMN.pull, "sleeve");
  assert.equal(COLUMN.pay, "seller");
});
