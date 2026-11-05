/**
 * What a model actually costs, priced the way ACR already prices things.
 *
 * The method is not invented here. `anchors/_basket/ACR-INF.json` states it, and
 * this module follows it exactly so that Float's per-model prints and ACR's
 * index are the same measurement at two scales rather than two numbers that
 * happen to be about the same thing:
 *
 *   blend  0.75 prompt + 0.25 completion   — a read-heavy agent workload
 *   unit   usd_per_token * 1000            — priced per 1k tokens, not per token
 *   agg    median across providers
 *
 * A worked check, because a units bug here is invisible until it authorises the
 * wrong payment: openai/gpt-4o-mini quotes prompt 0.00000015 and completion
 * 0.0000006, so 0.75*1.5e-7 + 0.25*6e-7 = 2.625e-7 USD/token = 0.0002625 USD per
 * 1k tokens. `GET /par` independently reports 0.0002625 for that model. The two
 * agree, which is the point.
 *
 * WHAT IS NEW HERE is the spread. ACR's basket takes one published price per
 * model; Float asks OpenRouter for the per-PROVIDER endpoints of a single model,
 * which is where a real confidence interval comes from — three providers serving
 * gpt-4o-mini quote 0.00000015, 0.00000015 and 0.000000165, a 10% spread. The
 * forecaster spends that spread as its safety margin, so the treasury holds more
 * buffer when the market disagrees with itself.
 *
 * All money arithmetic is BigInt. Prices arrive as decimal STRINGS and are
 * converted exactly; a float round-trip of 0.000000165 is not the number anyone
 * published.
 */

/** USD per bundle, at 1e18 — the unit `FloatPrintStore.priceWad` stores. */
export const WAD = 10n ** 18n;

/** The blend, from `anchors/_basket/ACR-INF.json`'s `rule.blend`. */
export const BLEND_PROMPT_PCT = 75n;
export const BLEND_COMPLETION_PCT = 25n;

/** `rule.unit_conversion`: usd_per_token * 1000, i.e. priced per 1k tokens. */
export const TOKENS_PER_BUNDLE = 1000n;

/**
 * How many providers must answer before a median means anything.
 *
 * Two, not one: a single provider's price is that provider's price, and calling
 * it a market median would be a claim the data does not support. ACR's basket
 * takes the same position with `min_priced`, and `par.py` with `MIN_SELLERS`.
 */
export const MIN_PROVIDERS = 2;

/**
 * Exact decimal string to a WAD BigInt.
 *
 * Deliberately not `Number(s) * 1e18`: 0.000000165 is not representable, and the
 * product is 164999999999.99997, which then truncates to a price nobody quoted.
 * Handles plain decimals and the exponent form, because an API that returns
 * "1.5e-7" one day is not an API that promised not to.
 */
export function decimalToWad(s: string): bigint {
  const t = s.trim();
  if (!/^\d*\.?\d+(e-?\d+)?$/i.test(t)) throw new Error(`not a decimal price: ${s}`);

  const [mantissa, exp] = t.toLowerCase().split("e") as [string, string | undefined];
  const shift = exp ? Number(exp) : 0;
  const [whole = "0", frac = ""] = mantissa.split(".");

  // Work in a fixed 30-decimal scale, then reduce to 18, so an exponent shift
  // cannot run off the end of the fraction.
  const SCALE = 30;
  let digits = (whole + frac).replace(/^0+(?=\d)/, "");
  let pointFromRight = frac.length - shift;
  if (pointFromRight > SCALE) throw new Error(`price below representable precision: ${s}`);
  digits = digits + "0".repeat(SCALE - pointFromRight);
  const scaled = BigInt(digits);
  return scaled / 10n ** BigInt(SCALE - 18);
}

/** The 75/25 blend of one provider's prompt and completion price, per bundle. */
export function blendedPerBundleWad(promptPerToken: string, completionPerToken: string): bigint {
  const p = decimalToWad(promptPerToken);
  const c = decimalToWad(completionPerToken);
  const perToken = (p * BLEND_PROMPT_PCT + c * BLEND_COMPLETION_PCT) / 100n;
  return perToken * TOKENS_PER_BUNDLE;
}

/** Median of a BigInt sample. Even counts average the two middle values. */
export function median(xs: bigint[]): bigint {
  if (xs.length === 0) throw new Error("median of nothing");
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

/**
 * Half-width of the provider spread, in basis points of the median.
 *
 * Nearest-rank p10/p90 rather than interpolation, because with three providers
 * interpolation invents a price between two real ones. Returns 0 when every
 * provider agrees, which is the honest answer and not a missing value.
 */
export function spreadBps(xs: bigint[]): number {
  if (xs.length < 2) return 0;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
  const med = median(s);
  if (med === 0n) return 0;
  const half = (at(0.9) - at(0.1)) / 2n;
  const bps = Number((half * 10_000n) / med);
  // The store rejects anything wider than the price itself, and a spread that
  // wide means the fetch is wrong rather than the market being volatile.
  return Math.max(0, Math.min(10_000, bps));
}

export type ProviderQuote = {
  provider: string;
  perBundleWad: bigint;
};

export type ModelPrint = {
  /** The index id written on chain, e.g. "ACR-INF:openai/gpt-4o-mini". */
  index: string;
  model: string;
  priceWad: bigint;
  ciBps: number;
  providers: ProviderQuote[];
};

type EndpointsResponse = {
  data?: {
    id?: string;
    endpoints?: Array<{
      provider_name?: string;
      pricing?: { prompt?: string; completion?: string };
    }>;
  };
};

export function indexIdFor(model: string): string {
  return `ACR-INF:${model}`;
}

/**
 * Parse OpenRouter's per-provider endpoints into one print.
 *
 * Separated from the fetch so the arithmetic is testable without a network: the
 * tests feed it the real recorded shape. A provider missing either half of its
 * pricing is DROPPED rather than treated as free — a zero price would drag the
 * median down and make every honest quote look like an overcharge.
 */
export function printFromEndpoints(model: string, body: EndpointsResponse): ModelPrint {
  const eps = body.data?.endpoints ?? [];
  const providers: ProviderQuote[] = [];
  for (const e of eps) {
    const prompt = e.pricing?.prompt;
    const completion = e.pricing?.completion;
    if (!prompt || !completion) continue;
    let perBundleWad: bigint;
    try {
      perBundleWad = blendedPerBundleWad(prompt, completion);
    } catch {
      continue;
    }
    if (perBundleWad <= 0n) continue;
    providers.push({ provider: e.provider_name ?? "unnamed", perBundleWad });
  }

  if (providers.length < MIN_PROVIDERS) {
    throw new Error(
      `${model}: ${providers.length} priced provider(s), need ${MIN_PROVIDERS} — ` +
        `a single provider's price is not a market median`,
    );
  }

  const sample = providers.map((p) => p.perBundleWad);
  return {
    index: indexIdFor(model),
    model,
    priceWad: median(sample),
    ciBps: spreadBps(sample),
    providers,
  };
}

/** USD per bundle as a human string, for logs and the dashboard. */
export function wadToUsd(wad: bigint, decimals = 9): string {
  const whole = wad / WAD;
  const frac = (wad % WAD).toString().padStart(18, "0").slice(0, decimals);
  return `${whole}.${frac}`;
}

export async function fetchEndpoints(model: string, fetchImpl = fetch): Promise<EndpointsResponse> {
  const url = `https://openrouter.ai/api/v1/models/${model}/endpoints`;
  const r = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`openrouter ${model}: http ${r.status}`);
  return (await r.json()) as EndpointsResponse;
}

export async function fetchPrint(model: string, fetchImpl = fetch): Promise<ModelPrint> {
  return printFromEndpoints(model, await fetchEndpoints(model, fetchImpl));
}
