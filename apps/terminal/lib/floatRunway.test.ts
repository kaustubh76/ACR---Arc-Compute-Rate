import { test } from "node:test";
import assert from "node:assert/strict";

import { TOKENS_PER_BUNDLE, bundlesFor, cheapest, scaledPrice, toUnits, tokensFor, wad } from "./floatRunway";

/* Pinned against the two implementations that already compute runway, with the
   real recorded print for gpt-4o-mini: 0.0002625 USD per 1k tokens, which the
   chain stores as 262_500_000_000_000 wad and `float/src/prices.test.ts`
   asserts independently as the median of three providers. */

const GPT4O_MINI = 262_500_000_000_000n;
const TEN_USDC = 10_000_000n;

test("a bundle price truncates, exactly as both references truncate it", () => {
  /* 262_500_000_000_000 / 1e12 is 262.5, and integer division floors it to 262.
     That is very slightly generous and it is what `float/app/index.html` and
     `float_runway` both already do. Pinned so a later "fix" to floats cannot
     silently disagree with the dashboard a judge is shown. */
  const perBundle = GPT4O_MINI / 10n ** 12n;
  assert.equal(perBundle, 262n);
  assert.equal(bundlesFor(TEN_USDC, GPT4O_MINI), TEN_USDC / 262n);
  assert.equal(bundlesFor(TEN_USDC, GPT4O_MINI), 38_167n);
});

test("tokens are bundles times a thousand, which is what a print prices", () => {
  assert.equal(TOKENS_PER_BUNDLE, 1_000n);
  assert.equal(tokensFor(TEN_USDC, GPT4O_MINI), 38_167_000n);
  assert.equal(tokensFor(0n, GPT4O_MINI), 0n);
});

test("an unpriced index buys nothing rather than everything", () => {
  /* The attractive wrong answer: zero in the denominator reads as an infinite
     runway, which is the single most flattering thing this panel could say. */
  assert.equal(bundlesFor(TEN_USDC, 0n), null);
  assert.equal(tokensFor(TEN_USDC, 0n), null);
  assert.equal(wad("0"), null);
  assert.equal(wad(""), null);
  assert.equal(wad(undefined), null);
  assert.equal(wad("12.5"), null);
  assert.equal(wad("-1"), null);
  assert.equal(wad("abc"), null);
  assert.equal(wad("262500000000000"), GPT4O_MINI);
});

test("a price too small to cost one treasury unit says so", () => {
  // below 1e12 wad a bundle rounds to zero units; the references guard it with
  // `|| 1n`, which prices the bundle at a unit it does not cost.
  assert.equal(bundlesFor(TEN_USDC, 999_999_999_999n), null);
  assert.equal(bundlesFor(TEN_USDC, 10n ** 12n), TEN_USDC);
});

test("the treasury total converts without losing a cent", () => {
  assert.equal(toUnits(10), 10_000_000n);
  assert.equal(toUnits(6.83425), 6_834_250n);
  assert.equal(toUnits(0.000001), 1n);
  assert.equal(toUnits(0), 0n);
  assert.equal(toUnits(-1), null);
  assert.equal(toUnits(Number.NaN), null);
});

test("the what-if slider scales the chain's price without leaving the integers", () => {
  assert.equal(scaledPrice(GPT4O_MINI, 100), GPT4O_MINI, "100% is the chain's own price");
  assert.equal(scaledPrice(GPT4O_MINI, 200), GPT4O_MINI * 2n);
  assert.equal(scaledPrice(GPT4O_MINI, 50), GPT4O_MINI / 2n);
  // a dearer print buys less, which is the direction the slider is there to show
  const dearer = scaledPrice(GPT4O_MINI, 140)!;
  assert.ok(tokensFor(TEN_USDC, dearer)! < tokensFor(TEN_USDC, GPT4O_MINI)!);
  assert.equal(scaledPrice(GPT4O_MINI, 0), null);
  assert.equal(scaledPrice(GPT4O_MINI, -10), null);
  assert.equal(scaledPrice(GPT4O_MINI, Number.NaN), null);
});

test("the cheapest print is the smallest priced one, stale or not", () => {
  const rows = [
    { name: "dear", price_wad: "640000000000000" },
    { name: "mid", price_wad: "450225000000000" },
    { name: "cheap", price_wad: "262500000000000" },
    { name: "unpriced", price_wad: "0" },
  ];
  assert.equal(cheapest(rows)?.name, "cheap");
  /* A stale print is still the last thing the chain said. Dropping it would
     make a quiet keeper look like an empty store; the row says stale, the
     arithmetic does not pretend it is absent. */
  assert.equal(cheapest([{ name: "only", price_wad: "640000000000000" }])?.name, "only");
  assert.equal(cheapest([{ name: "none", price_wad: "0" }]), null);
  assert.equal(cheapest([]), null);
});
