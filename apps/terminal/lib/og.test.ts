import { test } from "node:test";
import assert from "node:assert/strict";
import { freshnessLine, stateColor, INK, OG_BASE } from "./og";
import { PRINT_MAX_AGE_S, PRINT_WARN_AGE_S } from "./printAge";

const NOW = 1_800_000_000;

test("a current print says so, with its age", () => {
  const r = freshnessLine(NOW - 600, NOW, true);
  assert.equal(r.state, "fresh");
  assert.match(r.text, /^posted 10 min ago · live on chain$/);
});

test("a late print is late, not live", () => {
  const r = freshnessLine(NOW - PRINT_WARN_AGE_S - 60, NOW, true);
  assert.equal(r.state, "late");
  assert.doesNotMatch(r.text, /live/);
});

test("an overdue print never carries the word live", () => {
  for (const age of [PRINT_MAX_AGE_S + 1, 4 * 3600, 25 * 86400]) {
    const r = freshnessLine(NOW - age, NOW, true);
    assert.equal(r.state, "overdue");
    assert.doesNotMatch(r.text, /live/i, `${age}s: ${r.text}`);
    assert.match(r.text, /past the settle window/);
  }
});

test("no timestamp and no clock both read as unknown, never as fresh", () => {
  assert.equal(freshnessLine(undefined, NOW, true).state, "unknown");
  assert.equal(freshnessLine(NOW - 10, 0, true).state, "unknown");
  assert.match(freshnessLine(null, NOW, true).text, /archived/);
});

test("an estimator figure is labelled sim regardless of age", () => {
  const r = freshnessLine(NOW - 10, NOW, false);
  assert.equal(r.state, "sim");
  assert.match(r.text, /sim estimate/);
});

test("the dot colours follow the page's chips", () => {
  assert.equal(stateColor("fresh"), INK.teal);
  assert.equal(stateColor("late"), INK.gold);
  assert.equal(stateColor("overdue"), INK.mute);
  assert.equal(stateColor("unknown"), INK.mute);
  assert.equal(stateColor("sim"), INK.mute);
});

test("the OpenGraph base names the site, so an override can restate it", () => {
  assert.equal(OG_BASE.type, "website");
  assert.match(OG_BASE.siteName, /Arc Compute Rate/);
});
