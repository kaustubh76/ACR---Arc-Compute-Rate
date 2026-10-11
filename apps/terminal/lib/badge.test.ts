import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeSvg, cardSvg, esc, shortAge, CARD_SIZE } from "./badge";
import { freshnessLine, INK } from "./og";

const NOW = 1_800_000_000;

function input(over: Partial<Parameters<typeof badgeSvg>[0]> = {}) {
  const f = freshnessLine(NOW - 600, NOW, true);
  return {
    index: "ACR-INF",
    value: 0.49533,
    unit: "$/1k tokens",
    state: f.state,
    ageS: 600,
    line: f.text,
    chain: "Arc",
    ciHalfBp: 45.2,
    costToMove1pct: 0.38,
    host: "example.test",
    ...over,
  };
}

function width(svg: string): number {
  const m = svg.match(/<svg[^>]*\swidth="(\d+)"/);
  assert.ok(m, "svg has a width");
  return Number(m[1]);
}

test("a badge is as wide as its text, so a long unit never clips", () => {
  const short = width(badgeSvg(input({ unit: "$/MB" })));
  const long = width(badgeSvg(input({ unit: "$/1k tokens" })));
  assert.ok(long > short, `${long} should exceed ${short}`);
  const wider = width(badgeSvg(input({ index: "ACR-DATA" })));
  assert.ok(wider > width(badgeSvg(input())), "a longer index widens the left cell");
});

test("the number and the age are on the badge, and the chain is in its title", () => {
  const svg = badgeSvg(input());
  assert.match(svg, />0\.49533 \$\/1k tokens</);
  assert.match(svg, />10m</);
  assert.match(svg, /<title>ACR-INF · 0\.49533 \$\/1k tokens · posted 10 min ago · live on chain · Arc<\/title>/);
  assert.match(svg, /data-chain="Arc"/);
});

test("an overdue print is grey and never says live, on the badge and the card", () => {
  const f = freshnessLine(NOW - 4 * 3600, NOW, true);
  for (const svg of [badgeSvg(input({ ...f, state: f.state, line: f.text, ageS: 4 * 3600 })), cardSvg(input({ state: f.state, line: f.text, ageS: 4 * 3600 }))]) {
    assert.doesNotMatch(svg, /live/i);
    assert.match(svg, /past the settle window/);
    assert.match(svg, new RegExp(`fill="${INK.mute}"`));
    assert.doesNotMatch(svg, new RegExp(`fill="${INK.teal}"`));
  }
});

test("a current print wears teal and a late one gold", () => {
  assert.match(badgeSvg(input()), new RegExp(`fill="${INK.teal}"`));
  const late = freshnessLine(NOW - 100 * 60, NOW, true);
  assert.match(badgeSvg(input({ state: late.state, line: late.text, ageS: 6000 })), new RegExp(`fill="${INK.gold}"`));
});

test("a sim figure reads sim rather than an age", () => {
  const f = freshnessLine(null, NOW, false);
  const svg = badgeSvg(input({ state: f.state, line: f.text, ageS: null }));
  assert.match(svg, />sim</);
  assert.match(svg, /sim estimate/);
});

test("every string is escaped before it reaches the markup", () => {
  assert.equal(esc(`a<b&c"d>`), "a&lt;b&amp;c&quot;d&gt;");
  const svg = badgeSvg(input({ index: "A<B&C" }));
  assert.match(svg, /A&lt;B&amp;C/);
  assert.doesNotMatch(svg, /A<B/);
});

test("short ages round to the unit a 20px badge can hold", () => {
  assert.equal(shortAge(null), "?");
  assert.equal(shortAge(30), "<1m");
  assert.equal(shortAge(600), "10m");
  assert.equal(shortAge(4 * 3600), "4h");
  assert.equal(shortAge(3 * 86400), "3d");
});

test("the card carries the service, the interval, the cost to move and the host", () => {
  const svg = cardSvg(input());
  assert.match(svg, new RegExp(`width="${CARD_SIZE.width}" height="${CARD_SIZE.height}"`));
  assert.match(svg, />ACR-INF · INFERENCE</);
  assert.match(svg, />0\.49533</);
  assert.match(svg, /\$\/1k tokens · ±45\.2 bp \(95%\)/);
  assert.match(svg, /cost to move 1%: \$0\.38/);
  assert.match(svg, />example\.test</);
  assert.match(svg, /posted 10 min ago · live on chain/);
});

test("a card without an interval or a cost leaves those lines out, never prints NaN", () => {
  const svg = cardSvg(input({ ciHalfBp: undefined, costToMove1pct: undefined, host: undefined }));
  assert.doesNotMatch(svg, /NaN|undefined|cost to move/);
});
