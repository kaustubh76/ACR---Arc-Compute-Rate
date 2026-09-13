/** The indexed tape — reductions over what the subgraph publishes.
 *
 * Pure on purpose. `npm test` runs only lib/*.test.ts, so arithmetic that lives
 * inside a .tsx is arithmetic nobody can assert on — and every number this
 * module produces is one a reader would act on.
 *
 * The whole risk here is unit drift, not a crash. The subgraph publishes three
 * different scales and one of them is not a scale at all:
 *
 *   amounts (USDC)        1e6   — Settlement.amount, *Volume, spent, overpay
 *   prices/quantities     1e18  — unitPrice, arrivalValue, mark, quantity
 *   slippageBp                  — already whole basis points, signed
 *   wSlipTenthBp          NOT A RATE. A product of USDC-1e6 volume and tenths
 *                               of a basis point. There is exactly one correct
 *                               reduction and `bpFromWeighted` is it.
 *
 * A page that divides by the wrong constant renders a confident wrong number
 * under a live badge, which is the failure this project keeps catching.
 */

/* The Graph serialises BigInt as a decimal string; Int arrives as a number. */
export type Big = string | number;

function num(v: Big | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** USDC 1e6 → dollars. */
export function usdc6(v: Big | null | undefined): number | null {
  const n = num(v);
  return n === null ? null : n / 1e6;
}

/** WAD 1e18 → a decimal price or quantity.
 *
 * A WAD price carries 18 digits and a JS number holds ~16, so the last digits
 * are lost. That is fine for a rate rendered to 5–8 places and wrong for
 * anything that must round-trip — never send this value back on chain. */
export function wad18(v: Big | null | undefined): number | null {
  const n = num(v);
  return n === null ? null : n / 1e18;
}

/** Volume-weighted slippage in basis points — THE reduction.
 *
 * `wSlipTenthBp` is `sum(amount * slippageTenthBp)` over benchmarked
 * settlements: a USDC-1e6 × tenth-bp product. Dividing it by 1e6, or by 10
 * alone, or by the settlement count, all produce a plausible-looking number
 * that is wrong. It is `/ benchmarkedVolume / 10`, and nothing else.
 *
 * Null when there is no benchmarked volume — which is NOT zero slippage, it is
 * an absence of anything to measure. */
export function bpFromWeighted(wSlipTenthBp: Big | null | undefined, bmVolume: Big | null | undefined): number | null {
  const w = num(wSlipTenthBp);
  const v = num(bmVolume);
  if (w === null || v === null || v <= 0) return null;
  return w / v / 10;
}

/** The seven histogram buckets, matching `bucketOf` in graph/src/tca.ts.
 *
 * Edges are in whole basis points and are half-open [lo, hi). The labels are
 * the axis of every distribution this module feeds. */
export const BUCKETS: ReadonlyArray<{ key: string; lo: number | null; hi: number | null; label: string }> = [
  { key: "b0", lo: null, hi: -100, label: "under -100" },
  { key: "b1", lo: -100, hi: 0, label: "-100 to 0" },
  { key: "b2", lo: 0, hi: 50, label: "0 to 50" },
  { key: "b3", lo: 50, hi: 100, label: "50 to 100" },
  { key: "b4", lo: 100, hi: 200, label: "100 to 200" },
  { key: "b5", lo: 200, hi: 500, label: "200 to 500" },
  { key: "b6", lo: 500, hi: null, label: "500 and over" },
];

export interface BucketRow {
  b0: number; b1: number; b2: number; b3: number; b4: number; b5: number; b6: number;
}

/** Total settlements across the histogram.
 *
 * This equals `n`, the BENCHMARKED count — never `nAll`. An unbenchmarked
 * settlement fires no bucket (graph/src/rollup.ts), because "no print preceded
 * this trade" is not a slippage of zero. A caller that labels this total
 * "purchases" is mislabelling it. */
export function bucketTotal(row: BucketRow | null | undefined): number {
  if (!row) return 0;
  return BUCKETS.reduce((sum, b) => sum + (Number(row[b.key as keyof BucketRow]) || 0), 0);
}

/** Bucket counts as bar heights, 0..1, for a distribution strip. */
export function bucketBars(row: BucketRow | null | undefined): { key: string; label: string; n: number; frac: number }[] {
  const total = bucketTotal(row);
  return BUCKETS.map((b) => {
    const n = row ? Number(row[b.key as keyof BucketRow]) || 0 : 0;
    return { key: b.key, label: b.label, n, frac: total > 0 ? n / total : 0 };
  });
}

/** The grade a score earns — mirrors `_grade` in services/index_api/index_api/tca.py.
 *
 * Duplicated deliberately so the page can grade a score it computed locally,
 * and bound by a test to the Python thresholds so the two cannot drift. */
export function gradeOf(score: number | null | undefined): "A" | "B" | "C" | "D" | "Unrated" {
  if (score === null || score === undefined || !Number.isFinite(score)) return "Unrated";
  if (score >= 0.85) return "A";
  if (score >= 0.7) return "B";
  if (score >= 0.5) return "C";
  return "D";
}

/** Benchmarked settlements a seller needs before a grade is published —
 *  `MIN_RATED_N` in tca.py. Below it the honest answer is a reason, not a letter. */
export const MIN_RATED_N = 20;

/** Signed basis points, with an explicit sign and the house ellipsis for absent.
 *  Positive means the payer paid ABOVE the benchmark it could have seen. */
export function bp(v: number | null | undefined, dp = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "…";
  return `${v > 0 ? "+" : ""}${v.toFixed(dp)} bp`;
}

/* ── the shapes the API actually returns ─────────────────────────────────── */

export interface Reroute {
  from: string;
  to: string;
  saving_bp: number;
  saving_usdc: number;
  basis: string;
  note: string;
}

export interface TcaSellerRow {
  seller: string;
  vw_slippage_bp: number | null;
  volume_usdc: number;
  volume_share: number | null;
  n: number;
  synthetic_share: number | null;
  /** Share of this seller's volume paid by wallets HumanIdMirror resolves to a
   *  person in the window each settlement landed in. Same shape and the same
   *  fold as `synthetic_share`; `null` is "no volume", never "nobody". */
  human_share?: number | null;
}

export interface TcaCard {
  available: true;
  source: string;
  payer: string;
  window_days: number;
  purchases: number;
  benchmarked: number;
  spent_usdc: number;
  vw_slippage_bp: number | null;
  overpaid_usdc: number;
  by_seller: TcaSellerRow[];
  reroute: Reroute | null;
}

export interface Unavailable {
  available: false;
  reason: string;
  source?: string;
}

export type TcaResult = TcaCard | Unavailable;

export interface TapeAttestation {
  modelClass: number;
  latencySloMs: number;
  blockTime: Big;
}

export interface TapeSeller {
  id: string;
  totalVolume: Big;
  benchmarkedVolume: Big;
  settlementCount: number;
  distinctPayers: number;
  latestAttestation: TapeAttestation | null;
  /** Present only on the settlement-derived directory. */
  syntheticShare?: number | null;
  humanShare?: number | null;
  /** Per-window rollups from the `sellers` operation. `humanVolume` is the part of
   *  `volume` paid by wallets resolved to a person IN THAT WINDOW — which is why
   *  the share must be read off the current window, not summed across them. */
  windows?: SellerWindow[];
}

export interface SellerWindow {
  window: string | number;
  volume: Big;
  humanVolume: Big;
  distinctPayers?: number;
  distinctHumans?: number;
}

/** The human share of a seller's volume for ONE window, or null when that window
 *  has no volume. Null, not zero: a seller nobody bought from this week has not
 *  been measured, and "not measured" must not render as "no humans". */
export function humanShareInWindow(windows: SellerWindow[] | undefined, window: number): number | null {
  const w = (windows ?? []).find((x) => Number(x.window) === window);
  if (!w) return null;
  const vol = Number(w.volume) || 0;
  return vol > 0 ? (Number(w.humanVolume) || 0) / vol : null;
}

export interface TapeMeta {
  block: number;
  timestamp: number;
  hasIndexingErrors: boolean;
  deployment: string;
}

/** What /api/tape serves. Every field is nullable because every one of them can
 *  be independently unreachable, and "we could not read this" is not a value. */
/** One of the chosen payer's newest purchases — the evidence the reroute card
 *  reads against its own suggestion. Derived from the settlements the route
 *  already fetches; nothing is re-queried for it. */
export interface TapeRecentRow {
  seller: string;
  settledAt: number;
  amountUsdc: number;
  human: boolean;
}

export interface TapeData {
  meta: TapeMeta | null;
  tca: TcaResult | null;
  /** The payer's newest purchases, newest first. Empty when the tape has none. */
  recent: TapeRecentRow[];
  sellers: TapeSeller[];
  /** Grades keyed by lowercase seller address; absent while /rating is down. */
  ratings: Record<string, SellerRating>;
  /** Benchmarked futures fills — the control group. Zero by construction. */
  control: { fills: number; nonZero: number } | null;
  payer: string | null;
}

/** The `human_depth` rating component — who traded here, counted in PEOPLE.
 *
 * Three states, and collapsing any two of them is the bug this models around:
 *
 *   absent            no resolved human has traded with this seller yet. The
 *                     press omits the key entirely (`elif win_humans > 0`), so
 *                     `undefined` here means "not measured", never "zero people".
 *   available: false  a window longer than the 7-day rotation was asked for, and
 *                     human counts cannot be summed across windows. Carries why.
 *   available: true   measured, for ONE rotation window.
 *
 * `sandbox_humans` rides along for the same reason `synthetic_share` does: a
 * count that cannot be discounted gets read as more than it is, and every demo
 * identity here is a World ID Sandbox identity rather than an Orb-verified
 * person. */
export interface HumanDepth {
  available: boolean;
  reason?: string;
  score?: number | null;
  distinct_humans?: number;
  distinct_payers?: number;
  sandbox_humans?: number;
  sandbox_share?: number | null;
  human_volume_share?: number | null;
  window?: number;
  window_days?: number;
}

export interface SellerRating {
  available: boolean;
  reason?: string;
  grade?: string;
  unrated_reason?: string | null;
  score?: number | null;
  weight_covered_pct?: number;
  n?: number;
  n_all?: number;
  volume_usdc?: number;
  synthetic_share?: number | null;
  histogram?: BucketRow;
  /** Per-component detail. Only `human_depth` is read here; the rest exist. */
  components?: { human_depth?: HumanDepth };
}

/** What a cell should SAY about human depth, as a decision rather than a render.
 *
 * MEASURED AGAINST THE LIVE PRESS, not assumed from reading the branch. The key
 * is ALWAYS present — `tca.py` has an `else` that reports
 * `available:false, "no human resolutions on the tape for this window"` — so a
 * model built on "absent means nobody" would have had a state that never fires
 * and a label that was wrong about the one that does. What actually varies is
 * whether a count exists, and the press's own reason says why when it does not:
 *
 *   count       available, and at least one resolved person bought here
 *   unmeasured  everything else, carrying the press's reason verbatim
 *
 * Two states, because that is how many there are. The reason is never synthesised
 * here: "nobody has bought here yet" and "this window cannot be summed" are the
 * press's distinctions to draw, and inventing our own phrasing for them is how a
 * surface starts disagreeing with the service behind it. */
export type HumanCell =
  | { kind: "unmeasured"; note: string }
  | { kind: "count"; humans: number; payers: number | null; allSandbox: boolean };

const NOT_MEASURED = "no verified-person count for this seller";

export function humanCell(rating: SellerRating | undefined): HumanCell {
  const hd = rating?.components?.human_depth;
  if (hd == null) return { kind: "unmeasured", note: NOT_MEASURED };
  if (!hd.available) return { kind: "unmeasured", note: hd.reason ?? NOT_MEASURED };
  const humans = Number(hd.distinct_humans ?? 0);
  // A present-but-zero count is still not a count. Rendering "0 people" would
  // claim we looked and found nobody, which is a different fact from the press
  // declining to measure.
  if (!Number.isFinite(humans) || humans <= 0) {
    return { kind: "unmeasured", note: hd.reason ?? NOT_MEASURED };
  }
  const sandbox = Number(hd.sandbox_humans ?? 0);
  const payers = Number.isFinite(Number(hd.distinct_payers))
    ? Number(hd.distinct_payers)
    : null;
  return { kind: "count", humans, payers, allSandbox: humans > 0 && sandbox === humans };
}

/** One row of the `settlements` operation — the tape at its finest grain. */
export interface TapeSettlement {
  seller: { id: string } | null;
  payer: { id: string } | null;
  amount: Big;
  slippageBp: Big | null;
  benchmarked: boolean;
  synthetic: boolean;
  /** Unix seconds, from the mirror. Optional: an older index answer may lack it. */
  settledAt?: Big;
  /** Stamped at finalize by the subgraph (mirror.ts) — true when the payer had a
   *  cluster for the window the settlement landed in. Optional because an older
   *  index answer may predate the field; absent reads as false, never as true. */
  human?: boolean;
}

/** The seller directory, grouped out of raw settlements.
 *
 * The `sellers` operation is the right source and this is the fallback for when
 * it cannot answer — it gained a relation the deployed subgraph does not carry,
 * and a page that dies because one operation grew a field is a brittle page.
 *
 * This is grouping, not measurement: `slippageBp` still comes from the mapping,
 * computed against an arrival snapshot taken at the settling block. Nothing here
 * re-prices anything.
 *
 * Volume-weighted slippage is weighted by the BENCHMARKED amount only, matching
 * `bpFromWeighted`, so a seller with unpriced fills is not quietly credited with
 * a better average than its measured fills earned. */
export function sellersFromSettlements(rows: TapeSettlement[]): (TapeSeller & { vw_slippage_bp: number | null })[] {
  const acc = new Map<
    string,
    { vol: number; bmVol: number; weighted: number; n: number; payers: Set<string>; synth: number; human: number }
  >();
  for (const r of rows ?? []) {
    const id = r?.seller?.id;
    if (!id) continue;
    const amount = Number(r.amount) || 0;
    const e =
      acc.get(id) ?? { vol: 0, bmVol: 0, weighted: 0, n: 0, payers: new Set<string>(), synth: 0, human: 0 };
    e.vol += amount;
    e.n += 1;
    if (r.payer?.id) e.payers.add(r.payer.id);
    if (r.synthetic) e.synth += amount;
    if (r.human) e.human += amount;
    if (r.benchmarked && r.slippageBp !== null && r.slippageBp !== undefined) {
      e.bmVol += amount;
      e.weighted += amount * Number(r.slippageBp);
    }
    acc.set(id, e);
  }
  return [...acc.entries()].map(([id, e]) => ({
    id,
    totalVolume: e.vol,
    benchmarkedVolume: e.bmVol,
    settlementCount: e.n,
    distinctPayers: e.payers.size,
    latestAttestation: null,
    // Already whole basis points here (the operation exposes slippageBp, not
    // slippageTenthBp), so this is a plain volume weighting, not the tenth-bp
    // reduction — hence not bpFromWeighted.
    vw_slippage_bp: e.bmVol > 0 ? e.weighted / e.bmVol : null,
    syntheticShare: e.vol > 0 ? e.synth / e.vol : null,
    humanShare: e.vol > 0 ? e.human / e.vol : null,
  }));
}

/** Sellers ordered the way a payer reads them: dearest against the benchmark
 *  first, unpriced last. Mirrors the sort `payer_tca` already applies to
 *  `by_seller`, so the two tables on the page cannot disagree about "worst". */
export function byWorstFirst<T extends { vw_slippage_bp: number | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const av = a.vw_slippage_bp;
    const bv = b.vw_slippage_bp;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });
}

/** The chosen payer's newest `n` purchases, newest first — from the settlements
 *  the route already holds. Rows with no seller or no timestamp are skipped
 *  rather than rendered as a purchase from nobody at no time. */
export function recentForPayer(rows: TapeSettlement[], payer: string | null, n = 5): TapeRecentRow[] {
  if (!payer) return [];
  const who = payer.toLowerCase();
  return rows
    .filter((r) => r.payer?.id?.toLowerCase() === who && r.seller?.id && r.settledAt != null)
    .map((r) => ({
      seller: r.seller!.id.toLowerCase(),
      settledAt: Number(r.settledAt),
      amountUsdc: usdc6(r.amount) ?? 0,
      human: Boolean(r.human),
    }))
    .sort((a, b) => b.settledAt - a.settledAt)
    .slice(0, n);
}

export type RerouteFollowed = "followed" | "ignored" | "elsewhere" | "none";

/** Did the payer's LATEST purchase land where the suggestion points?
 *
 *  Three answers and an absence, because "the buyer acted on this" is the claim
 *  the whole loop rests on and it must be read off the tape, never assumed:
 *  `followed` (newest seller is the suggested one), `ignored` (newest is the one
 *  to leave), `elsewhere` (a third seller), `none` (no purchase on the tape). */
export function followedReroute(
  recent: TapeRecentRow[],
  reroute: { from: string; to: string } | null | undefined,
): RerouteFollowed {
  if (!reroute || recent.length === 0) return "none";
  const newest = recent[0].seller.toLowerCase();
  if (newest === reroute.to.toLowerCase()) return "followed";
  if (newest === reroute.from.toLowerCase()) return "ignored";
  return "elsewhere";
}
