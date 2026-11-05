/**
 * The models Float prices, and the agents that spend against them.
 *
 * THREE MODELS, chosen for provider disagreement rather than popularity. The
 * confidence interval in a print is the spread between providers serving the
 * same model, and the forecaster spends that spread as its buffer margin — so a
 * single-provider model would give a zero CI and the treasury would hold no
 * margin at all while appearing to compute one.
 *
 * Measured 2026-11-05, and chosen so the three spreads differ rather than
 * agreeing — a treasury that only ever sees 5% disagreement never demonstrates
 * why it carries a margin at all:
 *
 *   openai/gpt-4o-mini                 3 providers   500 bp   $0.0002625/1k
 *   deepseek/deepseek-chat             3 providers  1027 bp   $0.000450225/1k
 *   meta-llama/llama-3.3-70b-instruct  9 providers  3437 bp   $0.00064/1k
 *
 * The last is the interesting one: nine providers serve the same open-weights
 * model between $0.000155 and $0.000783, a FIVE-FOLD disagreement about one
 * product. That is the case for pricing compute at all, and it is why the fair
 * band is a band.
 *
 * Several obvious candidates are deliberately absent because the fetch refused
 * them: llama-3.1-70b and qwen-2.5-72b have a single priced provider, and
 * gemini-2.0-flash, mistral-small and claude-3.5-haiku return none. A model
 * without two priced providers cannot carry a measured interval, so it is not a
 * candidate — `npm run prices -- <models>` says so rather than guessing.
 */
export const SEED_MODELS: readonly string[] = [
  "openai/gpt-4o-mini",
  "deepseek/deepseek-chat",
  "meta-llama/llama-3.3-70b-instruct",
];

/** The agent ids the vault knows, as `keccak256(name)` preimages. */
export const SCOUT = "scout";
export const WASTER = "waster";
