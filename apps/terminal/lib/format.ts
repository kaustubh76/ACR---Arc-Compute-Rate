/* All display formatting lives here. Print `ts` is SIM-seconds (k·3600), not
   epoch — never render it as a date. It becomes the Fixing (edition) number;
   wall-clock "published at" comes from the envelope's fetchedAt. A fixed
   locale avoids SSR/client hydration mismatches. */

const LOCALE = "en-US";

/** What a number that is not a number looks like on the page.
 *
 *  An ellipsis: the mark for "not read yet", which is what an unreadable field
 *  actually is. It used to be an em dash, which read as generic placeholder
 *  filler across every table; before that a missing field reached
 *  `toLocaleString` and rendered the literal string "NaN" — not a degradation,
 *  a typo-shaped lie about a figure this paper's whole argument rests on. */
const NOT_A_NUMBER = "…";

function finite(n: number): boolean {
  return typeof n === "number" && Number.isFinite(n);
}

export function fmt(n: number, dp = 5): string {
  if (!finite(n)) return NOT_A_NUMBER;
  return n.toLocaleString(LOCALE, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** A price, at constant SIGNIFICANT figures rather than constant decimals.
 *
 *  `fmt` is fixed at 5 decimal places, which is five significant figures for
 *  ACR-INF (~0.49) and **two** for ACR-DATA (~0.0021). A 50bp spread on 0.0021
 *  is ±5.3e-6 — below the 1e-5 quantum five decimals can resolve — so the quote
 *  corridor rendered ACR-DATA's mid AND ask as the identical string "0.00210",
 *  and its bid/mid/ask read as two numbers instead of three.
 *
 *  Deriving the decimals from the magnitude gives every index the same
 *  resolution regardless of the unit it happens to be quoted in. ACR-INF is
 *  byte-identical to `fmt` at the default (log10(0.49) floors to -1 → 5 dp), so
 *  nothing already published moves; the smaller indices gain exactly the digits
 *  they were missing.
 *
 *  Deliberately NOT `fmt`'s new default: `fmt` renders nearly every number on
 *  the site, including ones tests and the snapshot pin. This is for prices. */
export function fmtPrice(n: number, sig = 5): string {
  if (!finite(n)) return NOT_A_NUMBER;
  // log10(0) is -Infinity and log10 of a negative is NaN — both would poison
  // the clamp, and neither is a price. Fall back to the fixed-decimal default.
  if (n === 0) return fmt(n);
  const dp = Math.min(9, Math.max(2, sig - 1 - Math.floor(Math.log10(Math.abs(n)))));
  return n.toLocaleString(LOCALE, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtInt(n: number): string {
  if (!finite(n)) return NOT_A_NUMBER;
  return Math.round(n).toLocaleString(LOCALE);
}

export function money(n: number, dp = 2): string {
  if (!finite(n)) return NOT_A_NUMBER;
  return "$" + n.toLocaleString(LOCALE, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function pct(n: number, dp = 1): string {
  if (!finite(n)) return NOT_A_NUMBER;
  return `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`;
}

/** Full CI width in basis points of the print value. */
export function ciWidthBp(p: { value: number; ci_lo: number; ci_hi: number }): number {
  return p.value > 0 ? (1e4 * (p.ci_hi - p.ci_lo)) / p.value : 0;
}

/** Half-width, the "±x.x bp" figure. */
export function halfCiBp(p: { value: number; ci_lo: number; ci_hi: number }): number {
  return ciWidthBp(p) / 2;
}

/** The figure to render as the hero. The on-chain oracle print is the
 *  settlement-grade record contracts settle against — lead with it whenever it
 *  exists; fall back to the sim estimate only when there is no on-chain print.
 *  `onchain` says which one we're showing so the UI can badge it honestly. */
export interface Hero {
  value: number;
  ci_lo: number;
  ci_hi: number;
  attack_cost_per_bp: number;
  onchain: boolean;
  posted_at: number | null;
}
export function heroFigure(p: {
  value: number;
  ci_lo: number;
  ci_hi: number;
  attack_cost_per_bp: number;
  onchain?: {
    value: number;
    ci_lo: number;
    ci_hi: number;
    attack_cost_per_bp: number;
    posted_at?: number;
  } | null;
}): Hero {
  const oc = p.onchain;
  if (oc) {
    return {
      value: oc.value,
      ci_lo: oc.ci_lo,
      ci_hi: oc.ci_hi,
      attack_cost_per_bp: oc.attack_cost_per_bp,
      onchain: true,
      posted_at: oc.posted_at ?? null,
    };
  }
  return {
    value: p.value,
    ci_lo: p.ci_lo,
    ci_hi: p.ci_hi,
    attack_cost_per_bp: p.attack_cost_per_bp,
    onchain: false,
    posted_at: null,
  };
}

/** Edition number: sim-hours since t0. The dateline's Fixing Nº. */
export function editionNo(ts: number): number {
  return Math.max(1, Math.round(ts / 3600));
}

export function editionLabel(ts: number): string {
  return `Nº ${fmtInt(editionNo(ts))}`;
}

/** Wall-clock publication time from the fetch envelope. */
export function publishedAt(fetchedAtMs: number): string {
  return new Date(fetchedAtMs).toISOString().slice(11, 19) + " UTC";
}

/** How long ago something happened, in words.
 *
 *  One helper because there were two, and they disagreed in public: the
 *  systems ledger said "30 min ago" while the dateline one strip above said
 *  "30m ago" about the very same keeper check. Same fact, two vocabularies,
 *  visible together on every page.
 *
 *  `null` is never a number. A chore that has not reported has NOT reported;
 *  "0s ago" would be the exact inversion of that, so it gets its own word. */
export function ageWords(ageS: number | null, plain = false): string {
  if (ageS == null) return plain ? "not yet" : "unread";
  if (ageS < 90) return "just now";
  const m = Math.round(ageS / 60);
  if (m < 90) return `${m} min ago`;
  return `${Math.round(m / 60)} hr ago`;
}

/** The same, for an absolute epoch-seconds stamp against a live clock.
 *  Returns null before the clock is running (`useNow()` is 0 on the server),
 *  so the caller can drop the segment rather than print a wrong age. */
export function ageWordsAt(atS: number | undefined, nowS: number): string | null {
  if (!atS || nowS <= 0) return null;
  return ageWords(Math.max(0, nowS - Math.round(atS)));
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export const SERVICE_NAMES: Record<string, string> = {
  "ACR-INF": "Inference",
  "ACR-GPU": "GPU Compute",
  "ACR-DATA": "Data Delivery",
};

export function serviceName(indexId: string): string {
  return SERVICE_NAMES[indexId] ?? indexId;
}
