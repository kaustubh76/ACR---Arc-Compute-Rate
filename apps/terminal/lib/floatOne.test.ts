import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agentPoint,
  benchmarkPoint,
  COLUMN,
  firstPaid,
  heights,
  litAt,
  onePayment,
  pointOf,
  runOrder,
  SCENE,
  script,
} from "./floatOne";
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
  /* SIX SINCE THE VENUE JOINED, and the shape is the contract's whether or not
     a particular payment took every hop. */
  assert.equal(beats.length, 6);
  for (const b of beats) {
    assert.equal(b.valueUsdc, null, `${b.key} must print no number`);
    assert.equal(b.logIndex, null);
    assert.equal(b.height, null);
  }
  assert.deepEqual(beats.map((b) => b.key), ["ask", "fair", "venue", "pull", "pay", "receipt"]);
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

/* --- the scene's geometry, as claims a suite can fail -------------------- */

test("the agent is never on the money plane, at any angle", () => {
  /* THE WHOLE DIAGRAM, per MoneyPath.tsx:11-16. In the flat version the agent
     hangs above the rail and a reader takes the gap on trust. In three
     dimensions it is off the plane from every direction the camera can reach,
     which is the only reason the camera is allowed to move. */
  const [, , az] = agentPoint();
  assert.equal(az, SCENE.z.offPlane);
  assert.notEqual(az, SCENE.z.money);
  assert.ok(SCENE.agentY > SCENE.ceil, "and above the axis, not on it");
});

test("the benchmark is off the money plane too, and over the treasury", () => {
  /* It checks a price and never touches a balance, so it belongs on the same
     plane as the agent. Over the treasury because the treasury is what does
     the checking (MoneyPath.tsx:41). */
  const [bx, by, bz] = benchmarkPoint();
  assert.equal(bz, SCENE.z.offPlane);
  assert.equal(bx, SCENE.x.treasury);
  assert.ok(by > SCENE.ceil, "off the axis: it has no log");
});

test("a beat with no log has no point in the scene", () => {
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkOk() });
  if (r.status !== "live") throw new Error("expected live");
  for (const b of r.beats) {
    const p = pointOf(b);
    if (b.height === null) assert.equal(p, null, `${b.key} has no log, so no point`);
    else assert.ok(p, `${b.key} has a log, so it has a point`);
  }
});

test("every beat that IS placed sits on the money plane, inside the axis", () => {
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkOk() });
  if (r.status !== "live") throw new Error("expected live");
  for (const b of r.beats) {
    const p = pointOf(b);
    if (!p) continue;
    assert.equal(p[2], SCENE.z.money, `${b.key} moves money, so it is on the money plane`);
    assert.ok(p[1] >= SCENE.floor && p[1] <= SCENE.ceil, `${b.key} is inside the axis`);
  }
});

test("the three custody columns are distinct, or the scene says nothing", () => {
  const { treasury, sleeve, seller } = SCENE.x;
  assert.equal(new Set([treasury, sleeve, seller]).size, 3);
});

test("an in-order payment puts the pull BELOW the pay in world space", () => {
  /* The unit under test is the geometry, not the arithmetic: this is the
     claim a reader checks by dragging the camera. */
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkOk() });
  if (r.status !== "live") throw new Error("expected live");
  const pull = pointOf(r.beats.find((b) => b.key === "pull")!)!;
  const pay = pointOf(r.beats.find((b) => b.key === "pay")!)!;
  assert.ok(pull[1] < pay[1], "the shortfall left the venue lower down than the seller was paid");
  assert.ok(pull[0] !== pay[0], "and from a different custody column");
});

test("a contradicted order is HIGHER in world space, so the picture is wrong on purpose", () => {
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
  const pull = pointOf(r.beats.find((b) => b.key === "pull")!)!;
  const pay = pointOf(r.beats.find((b) => b.key === "pay")!)!;
  assert.ok(pull[1] > pay[1], "plotted as the chain reported it, not as we would like it");
});

test("the scripted beats get no points at all, because they carry no logs", () => {
  for (const b of script()) assert.equal(pointOf(b), null);
});

/* --- the venue: the party that is not ours, and it moves first ----------- */

const VENUE_IDX = 29;
const walkWithVenue = (over: Partial<FloatWalk> = {}): FloatWalk =>
  walkOk({
    venue: "0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88",
    venue_log_index: VENUE_IDX,
    venue_usdc: 1.05525,
    venue_receiver: "0xb030e7e592eb2d8a989c7cbca01270b957bb4bdc",
    venue_shares: "1054134341145566439",
    venue_log_count: 4,
    ...over,
  });

test("the venue's log joins the axis, and re-spaces it honestly", () => {
  /* MEASURED FROM THE CANONICAL RECEIPT. With the venue the logged beats are
     29, 30, 32, 33 rather than 30, 32, 33, so the span is four and the sleeve's
     own record moves off the floor: the venue takes it, because the venue acted
     first. The gaps remain the real gaps. */
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkWithVenue() });
  if (r.status !== "live") throw new Error("expected live");
  const by = Object.fromEntries(r.beats.map((b) => [b.key, b]));
  assert.equal(by.venue.logIndex, 29);
  assert.equal(by.venue.height, 0);
  assert.equal(by.pull.height, 0.25);
  assert.equal(by.pay.height, 0.75);
  assert.equal(by.receipt.height, 1);
});

test("the venue sits IN FRONT of the money plane, the agent behind it", () => {
  /* Z means whose money-touching it is. The venue is the counterparty, so it is
     nearest the reader; the agent touches nothing, so it is furthest. */
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkWithVenue() });
  if (r.status !== "live") throw new Error("expected live");
  const venue = pointOf(r.beats.find((b) => b.key === "venue")!)!;
  const pull = pointOf(r.beats.find((b) => b.key === "pull")!)!;
  assert.equal(venue[2], SCENE.z.outside);
  assert.equal(pull[2], SCENE.z.money);
  assert.ok(venue[2] > pull[2], "in front of ours");
  assert.ok(agentPoint()[2] < pull[2], "and the agent is behind ours");
  assert.equal(new Set([SCENE.z.offPlane, SCENE.z.money, SCENE.z.outside]).size, 3);
});

test("the venue released the money BELOW where our sleeve recorded it", () => {
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkWithVenue() });
  if (r.status !== "live") throw new Error("expected live");
  const venue = pointOf(r.beats.find((b) => b.key === "venue")!)!;
  const pull = pointOf(r.beats.find((b) => b.key === "pull")!)!;
  assert.ok(venue[1] < pull[1], "log 29 lower than log 30");
});

test("the venue's facts survive to the surface, shares as a string", () => {
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkWithVenue() });
  if (r.status !== "live") throw new Error("expected live");
  assert.equal(r.venueUsdc, 1.05525);
  assert.equal(r.venueShares, "1054134341145566439");
  assert.equal(typeof r.venueShares, "string", "18 decimals would round as a number");
  assert.equal(r.venueLogs, 4);
  assert.equal(r.venueReceiver?.toLowerCase(), "0xb030e7e592eb2d8a989c7cbca01270b957bb4bdc");
});

test("no venue log is an absence, and the axis goes back to three", () => {
  /* A payment the buffer covered, or one pulled from the USYC reserve: neither
     touches Morpho, and neither is a venue that did nothing. */
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkOk() });
  if (r.status !== "live") throw new Error("expected live");
  const by = Object.fromEntries(r.beats.map((b) => [b.key, b]));
  assert.equal(by.venue.state, "none");
  assert.equal(by.venue.logIndex, null);
  assert.equal(by.venue.height, null);
  assert.equal(pointOf(by.venue), null);
  assert.equal(by.pull.height, 0, "the sleeve is back on the floor");
  assert.equal(by.pay.height, 2 / 3);
});

/* --- the run: what lights, in what order, and what is skipped ------------ */

test("a just-in-time payment through the venue lights all six, in log order", () => {
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkWithVenue() });
  if (r.status !== "live") throw new Error("expected live");
  assert.deepEqual(runOrder(r.beats, r.jit), ["ask", "fair", "venue", "pull", "pay", "receipt"]);
});

test("a payment the buffer covered skips the venue AND our sleeve", () => {
  /* SKIPPED, NOT ANIMATED. Walking a reader past two stations that did nothing
     would claim a hop the payment never took. */
  const r = onePayment({
    vault: null,
    tape: tape([paidRow({ jit_funded: false })]),
    walk: walkOk({ jit_funded: false, verdict: "not_jit", steps: [
      { n: 1, state: "ok" },
      { n: 2, state: "warn" },
      { n: 3, state: "ok", log_index: 32, value_usdc: 1.05525 },
      { n: 4, state: "ok", log_index: 33, value_usdc: 1.05525 },
    ] }),
  });
  if (r.status !== "live") throw new Error("expected live");
  assert.deepEqual(runOrder(r.beats, r.jit), ["ask", "fair", "pay", "receipt"]);
});

test("a reserve pull keeps our sleeve and drops the venue", () => {
  /* The USYC leg emits no Morpho log, but the sleeve still records a delivery. */
  const r = onePayment({ vault: null, tape: tape([paidRow()]), walk: walkOk() });
  if (r.status !== "live") throw new Error("expected live");
  assert.deepEqual(runOrder(r.beats, r.jit), ["ask", "fair", "pull", "pay", "receipt"]);
});

test("the lit set is cumulative, and nothing is lit before the run starts", () => {
  const order: ReturnType<typeof runOrder> = ["ask", "fair", "venue", "pull", "pay", "receipt"];
  assert.deepEqual([...litAt(order, -1)], []);
  assert.deepEqual([...litAt(order, 0)], ["ask"]);
  assert.deepEqual([...litAt(order, 2)], ["ask", "fair", "venue"]);
  assert.equal(litAt(order, 5).size, 6);
  assert.equal(litAt(order, 99).size, 6, "past the end stays lit, never wraps");
});

test("a refused run lights nothing past the gate", () => {
  /* The chain answers the gate and the money stations never come on, because
     nothing moved. Expressed here as the step a refusal stops at: the gate is
     beat 1, so a refusal never reaches 2. */
  const order: ReturnType<typeof runOrder> = ["ask", "fair", "venue", "pull", "pay", "receipt"];
  const lit = litAt(order, 1);
  assert.ok(lit.has("fair"));
  for (const k of ["venue", "pull", "pay", "receipt"] as const) {
    assert.ok(!lit.has(k), `${k} must stay dark on a refusal`);
  }
});

/* --- a moving window must not un-show a payment -------------------------- */

test("a tape poll that drops the row does NOT end a live payment", () => {
  /* MEASURED, AND IT BROKE A RUN. The tape is a moving ~9,000 block window that
     re-polls every twelve seconds. A poll that drifts past the newest payment,
     or comes back part-read, stops listing it — and keyed off the tape that
     turned a live payment into "no payment in this window" two beats into a
     walk a reader had started: stations out, scene unmounted, flat diagram in
     its place. The walk is the evidence; the tape is only how we found it. */
  const r = onePayment({ vault: null, tape: tape([]), walk: walkWithVenue({ agent_id: "0xd4b6" }) });
  assert.equal(r.status, "live", "the chain already showed us this transaction");
  if (r.status !== "live") return;
  assert.equal(r.tx, paidRow().tx);
  assert.equal(r.venueUsdc, 1.05525, "and its venue leg survives too");
});

test("what only the tape carries goes null when the window moves, never zero", () => {
  const r = onePayment({ vault: null, tape: tape([]), walk: walkWithVenue() });
  if (r.status !== "live") throw new Error("expected live");
  assert.equal(r.premiumBps, null, "a missing premium is not a premium of zero");
  assert.equal(r.indexId, null);
});

test("the agent comes off the walk, so a dry run survives the window moving", () => {
  /* The dry run needs the agent to ask the chain the same question again, and
     taking it off the tape row meant a moved window left the button unable to
     name the payment it was looking at. */
  const r = onePayment({ vault: null, tape: tape([]), walk: walkWithVenue({ agent_id: "0xd4b6ed56" }) });
  if (r.status !== "live") throw new Error("expected live");
  assert.equal(r.agentId, "0xd4b6ed56");
});

test("the walk still has to be OK: no walk is still no payment", () => {
  /* The inverse, so this does not become "always claim a payment". A walk that
     never answered, or answered pending, is not evidence of anything. */
  const noWalk = onePayment({ vault: { status: "ok", receipts: 2 } as FloatVaultState, tape: tape([]), walk: null });
  assert.equal(noWalk.status, "scripted");
  const pending = onePayment({
    vault: { status: "ok", receipts: 2 } as FloatVaultState,
    tape: tape([]),
    walk: { status: "pending", reason: "that payment could not be read" },
  });
  assert.equal(pending.status, "scripted");
});
