/* The reader's workload — the arithmetic that makes the paper theirs.
 *
 * Every figure this site publishes is identical for every visitor; this module
 * is the one place that changes that. A reader declares what they buy per
 * month, once, and the numbers they already look at gain one extra line: the
 * same rate, expressed as THEIR monthly bill. Pure functions over data every
 * page already fetches; nothing here talks to a network or a DOM, so node:test
 * can hold all of it (lib/edition.test.ts does).
 *
 * The catastrophic failure mode is unit drift, not a crash. Each index prints
 * in its own unit ("$/1k tokens", "$/GPU-sec", "$/MB") while a reader thinks in
 * M tokens, GPU-hours and GB, so every conversion below is a silent ×1000 or
 * ×3600 that no type checks. Get one wrong and the site mis-bills every reader
 * by three orders of magnitude under a live number that makes it look checked.
 * That is why UNIT_FACTORS is asserted against the unit strings in
 * fallback.json — a press-side unit change must break CI, not readers.
 */

import type { HistoryPoint } from "./types";

/** localStorage, same inventory as acr-edition / acr-desk-*. */
export const WORKLOAD_KEY = "acr-workload";

/** What the reader buys per month, in the units a buyer actually thinks in:
 *  millions of tokens, GPU-hours, gigabytes. 0 means "I don't buy this". */
export interface Workload {
  /** Inference, in MILLIONS of tokens per month. */
  inf: number;
  /** GPU compute, in GPU-HOURS per month. */
  gpu: number;
  /** Data delivery, in GB per month. */
  data: number;
}

/** Reader units → the print's own unit, per index.
 *
 *  ACR-INF prints in $/1k tokens; 1M tokens is 1000 of those units.
 *  ACR-GPU prints in $/GPU-second; a GPU-hour is 3600 of those.
 *  ACR-DATA prints in $/MB; a GB is 1000 of those (decimal, as sold).
 */
export const UNIT_FACTORS = {
  "ACR-INF": 1000,
  "ACR-GPU": 3600,
  "ACR-DATA": 1000,
} as const;

const FIELD_BY_INDEX = { "ACR-INF": "inf", "ACR-GPU": "gpu", "ACR-DATA": "data" } as const;
export type WorkloadIndexId = keyof typeof FIELD_BY_INDEX;

/** Whatever localStorage held → a Workload, or null.
 *
 *  Defensive on purpose: this parses a string a past build wrote and a future
 *  build will read, and anything unparseable must degrade to "no workload set"
 *  rather than NaN billing. All-zero is also null — a profile that buys
 *  nothing IS no profile, and treating it as one would render "$0.00/mo" lines
 *  everywhere, which reads as a price rather than an absence.
 */
export function parseWorkload(raw: unknown): Workload | null {
  if (typeof raw !== "string" || !raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const take = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  const w: Workload = {
    inf: take((obj as Record<string, unknown>).inf),
    gpu: take((obj as Record<string, unknown>).gpu),
    data: take((obj as Record<string, unknown>).data),
  };
  return w.inf > 0 || w.gpu > 0 || w.data > 0 ? w : null;
}

/** The reader's monthly cost on one index at a given mark, or null.
 *
 *  `mark` must be heroFigure(print).value — the number the page is already
 *  showing — never the raw sim value, or the personalized line disagrees with
 *  the figure above it. Null (not 0) when the reader does not buy this index
 *  or the mark is missing: a caller must choose a sentence, not print $0.00.
 */
export function monthlyCost(w: Workload, indexId: string, mark: number): number | null {
  const field = FIELD_BY_INDEX[indexId as WorkloadIndexId];
  if (!field) return null;
  const qty = w[field];
  if (!(qty > 0) || !(mark > 0)) return null;
  return qty * UNIT_FACTORS[indexId as WorkloadIndexId] * mark;
}

/** The whole bill across whatever indices have marks. Null until at least one
 *  line prices — an empty sum rendered as $0.00 would claim compute is free. */
export function totalCost(w: Workload, marks: Record<string, number | undefined>): number | null {
  let total: number | null = null;
  for (const id of Object.keys(FIELD_BY_INDEX)) {
    const c = monthlyCost(w, id, marks[id] ?? 0);
    if (c !== null) total = (total ?? 0) + c;
  }
  return total;
}

/** The rate's move over the last 24 fixings, in basis points, or null.
 *
 *  A RATIO from the history series, deliberately not a subtraction against the
 *  hero value: history is the press's hourly series while the hero may be the
 *  on-chain print, and differencing across that boundary manufactures a move
 *  at the seam. The ratio is series-internal, so it is safe to apply to a bill
 *  priced off either. Null when the series is too short — a missing move must
 *  never render as "unchanged".
 */
export function deltaBp(history: HistoryPoint[] | undefined): number | null {
  if (!history || history.length < 25) return null;
  const now = history[history.length - 1]!.value;
  const then = history[history.length - 25]!.value;
  if (!(now > 0) || !(then > 0)) return null;
  return 1e4 * (now / then - 1);
}

/** money() has no compaction and a masthead chip has no room for "$7,542.53".
 *  Two significant-ish tiers are enough for a chip; panels use money(). */
export function compactMoney(n: number): string {
  if (!Number.isFinite(n)) return "…";
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

/** One-tap starting points. Round numbers a reader edits, not claims. */
export const PRESETS: ReadonlyArray<{ name: string; w: Workload }> = [
  { name: "agent startup", w: { inf: 12, gpu: 40, data: 5 } },
  { name: "research lab", w: { inf: 60, gpu: 400, data: 25 } },
  { name: "data pipeline", w: { inf: 2, gpu: 20, data: 500 } },
];
