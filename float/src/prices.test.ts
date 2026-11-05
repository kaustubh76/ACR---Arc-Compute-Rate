import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blendedPerBundleWad,
  decimalToWad,
  indexIdFor,
  median,
  printFromEndpoints,
  spreadBps,
  wadToUsd,
  WAD,
} from "./prices.ts";

/**
 * The real recorded response for openai/gpt-4o-mini, trimmed to the fields the
 * parser reads. Three providers, and the third genuinely disagrees — which is
 * the whole reason Float asks for endpoints rather than taking one list price.
 */
const GPT4O_MINI = {
  data: {
    id: "openai/gpt-4o-mini",
    endpoints: [
      { provider_name: "Azure", pricing: { prompt: "0.00000015", completion: "0.0000006" } },
      { provider_name: "OpenAI", pricing: { prompt: "0.00000015", completion: "0.0000006" } },
      { provider_name: "Azure", pricing: { prompt: "0.000000165", completion: "0.00000066" } },
    ],
  },
};

test("a decimal price converts exactly, where a float would not", () => {
  assert.equal(decimalToWad("0.00000015"), 150_000_000_000n);
  assert.equal(decimalToWad("0.000000165"), 165_000_000_000n);
  assert.equal(decimalToWad("1"), WAD);
  assert.equal(decimalToWad("0.5"), WAD / 2n);
  assert.equal(decimalToWad("1.5e-7"), 150_000_000_000n);

  // The reason this function exists, with the value that proves it — and it is
  // not a contrived one: 0.0000002625 is exactly the blended per-token price
  // this pipeline computes for gpt-4o-mini, so it is a number Float handles on
  // every keeper tick. `Number(s) * 1e18` cannot represent it.
  assert.equal(decimalToWad("0.0000002625"), 262_500_000_000n);
  assert.equal(0.0000002625 * 1e18, 262_499_999_999.99997);
  // Truncating that — what BigInt() does to a non-integer — loses a unit of
  // price. Most prices survive the float path; the point is that you cannot
  // tell which, so the exact path is the only one in the code.
  assert.equal(BigInt(Math.trunc(0.0000002625 * 1e18)), 262_499_999_999n);
});

test("a malformed price is refused rather than coerced to zero", () => {
  assert.throws(() => decimalToWad(""), /not a decimal price/);
  assert.throws(() => decimalToWad("free"), /not a decimal price/);
  assert.throws(() => decimalToWad("-0.1"), /not a decimal price/);
});

test("the 75/25 blend reproduces the number /par independently reports", () => {
  // 0.75*1.5e-7 + 0.25*6e-7 = 2.625e-7 USD/token = 0.0002625 USD per 1k tokens.
  // `GET /par` reports 0.0002625 for openai/gpt-4o-mini from ACR's own basket,
  // which uses the same blend and the same *1000 conversion. If this assertion
  // ever disagrees with that route, one of the two has changed its method.
  const wad = blendedPerBundleWad("0.00000015", "0.0000006");
  assert.equal(wad, 262_500_000_000_000n);
  assert.equal(wadToUsd(wad, 7), "0.0002625");
});

test("a print takes the median across providers and prices the spread", () => {
  const p = printFromEndpoints("openai/gpt-4o-mini", GPT4O_MINI);
  assert.equal(p.index, "ACR-INF:openai/gpt-4o-mini");
  assert.equal(p.providers.length, 3);
  assert.equal(p.priceWad, 262_500_000_000_000n, "the median, not the mean");
  // The outlying provider is 10% dearer, so the half-width is 5% of the median.
  assert.equal(p.ciBps, 500);
});

test("providers that agree price a zero spread, which is an answer not a gap", () => {
  const same = {
    data: {
      endpoints: [
        { provider_name: "A", pricing: { prompt: "0.00000015", completion: "0.0000006" } },
        { provider_name: "B", pricing: { prompt: "0.00000015", completion: "0.0000006" } },
      ],
    },
  };
  assert.equal(printFromEndpoints("m", same).ciBps, 0);
});

test("a provider missing half its pricing is dropped, never treated as free", () => {
  const partial = {
    data: {
      endpoints: [
        { provider_name: "A", pricing: { prompt: "0.00000015", completion: "0.0000006" } },
        { provider_name: "B", pricing: { prompt: "0.00000015", completion: "0.0000006" } },
        { provider_name: "C", pricing: { prompt: "0.00000015" } },
        { provider_name: "D", pricing: { prompt: "0", completion: "0" } },
      ],
    },
  };
  const p = printFromEndpoints("m", partial);
  assert.equal(p.providers.length, 2, "C has no completion price, D is free");
  // A zero would have dragged the median to roughly half and made every honest
  // quote read as an overcharge against it.
  assert.equal(p.priceWad, 262_500_000_000_000n);
});

test("one provider is not a market median and says so", () => {
  const single = {
    data: {
      endpoints: [{ provider_name: "A", pricing: { prompt: "0.00000015", completion: "0.0000006" } }],
    },
  };
  assert.throws(() => printFromEndpoints("m", single), /1 priced provider/);
  assert.throws(() => printFromEndpoints("m", { data: { endpoints: [] } }), /0 priced provider/);
});

test("median handles even samples without inventing a price outside them", () => {
  assert.equal(median([3n, 1n]), 2n);
  assert.equal(median([1n, 2n, 3n]), 2n);
  assert.equal(median([10n]), 10n);
  assert.throws(() => median([]), /median of nothing/);
});

test("the spread is bounded, because a spread wider than the price is a fetch bug", () => {
  assert.equal(spreadBps([100n]), 0, "a lone sample has no spread");
  const huge = spreadBps([1n, 1_000_000_000n]);
  assert.ok(huge <= 10_000, `bounded, got ${huge}`);
});

test("the index id names the model, so a receipt says what was bought", () => {
  assert.equal(indexIdFor("deepseek/deepseek-chat"), "ACR-INF:deepseek/deepseek-chat");
});
