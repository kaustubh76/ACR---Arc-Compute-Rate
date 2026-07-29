import { test } from "node:test";
import assert from "node:assert/strict";
import { connState, STALE_WINDOW_S, WAKE_WINDOW_S, WAKE_ETA_S } from "./connection";

const base = {
  live: false,
  fetchedAt: 1_700_000_000_000,
  lastLiveAtS: null as number | null,
  wakeStartedAtS: null as number | null,
  onchainOk: false,
  nowS: 1_000,
};

test("live wins over everything", () => {
  const s = connState({
    ...base,
    live: true,
    lastLiveAtS: 999,
    wakeStartedAtS: 999,
    onchainOk: true,
  });
  assert.equal(s.state, "live");
  assert.equal(s.ageS, null);
});

test("provisional peek (fetchedAt 0) is linking, not archived", () => {
  const s = connState({ ...base, fetchedAt: 0 });
  assert.equal(s.state, "linking");
});

test("linking also on the server (nowS 0) before any fetch", () => {
  const s = connState({ ...base, fetchedAt: 0, nowS: 0 });
  assert.equal(s.state, "linking");
});

test("recently live → stale with age", () => {
  const s = connState({ ...base, lastLiveAtS: 1_000 - 30 });
  assert.equal(s.state, "stale");
  assert.equal(s.ageS, 30);
});

test("stale exactly at the window boundary", () => {
  const s = connState({ ...base, lastLiveAtS: 1_000 - STALE_WINDOW_S });
  assert.equal(s.state, "stale");
});

test("stale window expired → archived", () => {
  const s = connState({ ...base, lastLiveAtS: 1_000 - STALE_WINDOW_S - 1 });
  assert.equal(s.state, "archived");
});

test("wake in flight → waking with a countdown", () => {
  const s = connState({ ...base, wakeStartedAtS: 1_000 - 10 });
  assert.equal(s.state, "waking");
  assert.equal(s.wakeRemainingS, WAKE_ETA_S - 10);
});

test("waking countdown floors at zero", () => {
  const s = connState({ ...base, wakeStartedAtS: 1_000 - WAKE_ETA_S - 5 });
  assert.equal(s.state, "waking");
  assert.equal(s.wakeRemainingS, 0);
});

test("wake window expired, oracle answering → onchain-only", () => {
  const s = connState({
    ...base,
    wakeStartedAtS: 1_000 - WAKE_WINDOW_S - 1,
    onchainOk: true,
  });
  assert.equal(s.state, "onchain-only");
});

test("stale outranks waking while both hold", () => {
  const s = connState({ ...base, lastLiveAtS: 1_000 - 5, wakeStartedAtS: 1_000 - 5 });
  assert.equal(s.state, "stale");
});

test("nothing reachable, nothing recent → archived", () => {
  const s = connState(base);
  assert.equal(s.state, "archived");
});

test("onchain-only without any wake attempt", () => {
  const s = connState({ ...base, onchainOk: true });
  assert.equal(s.state, "onchain-only");
});
