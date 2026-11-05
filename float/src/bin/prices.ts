/**
 * Report what the market says right now, and how much it disagrees with itself.
 *
 *   npm run prices                 # the seeded models
 *   npm run prices -- model/a ...  # candidates, to pick a seed set
 *
 * Prints no transaction and signs nothing. Its job is to let a human choose
 * models whose providers genuinely disagree: a model served by one provider has
 * no spread, so the forecaster's margin would be zero and the confidence
 * interval in the print would be a decoration rather than a measurement.
 */
import { fetchPrint, wadToUsd } from "../prices.ts";
import { SEED_MODELS } from "../seed.ts";

const models = process.argv.slice(2).length > 0 ? process.argv.slice(2) : SEED_MODELS;

let failures = 0;
for (const model of models) {
  try {
    const p = await fetchPrint(model);
    const lo = p.providers.reduce((a, b) => (b.perBundleWad < a ? b.perBundleWad : a), p.providers[0]!.perBundleWad);
    const hi = p.providers.reduce((a, b) => (b.perBundleWad > a ? b.perBundleWad : a), 0n);
    console.log(
      `${model.padEnd(36)} $${wadToUsd(p.priceWad, 9)}/1k  ci=${String(p.ciBps).padStart(4)}bp  ` +
        `providers=${String(p.providers.length).padStart(2)}  range $${wadToUsd(lo, 9)}..$${wadToUsd(hi, 9)}`,
    );
  } catch (e) {
    failures += 1;
    console.log(`${model.padEnd(36)} UNUSABLE — ${(e as Error).message}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} model(s) unusable. A model without at least two priced providers`);
  console.log("cannot carry a confidence interval, so it is not a candidate.");
}
