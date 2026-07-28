/* All display formatting lives here. Print `ts` is SIM-seconds (k·3600), not
   epoch — never render it as a date. It becomes the Fixing (edition) number;
   wall-clock "published at" comes from the envelope's fetchedAt. A fixed
   locale avoids SSR/client hydration mismatches. */

const LOCALE = "en-US";

export function fmt(n: number, dp = 5): string {
  return n.toLocaleString(LOCALE, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString(LOCALE);
}

export function money(n: number, dp = 2): string {
  return "$" + n.toLocaleString(LOCALE, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function pct(n: number, dp = 1): string {
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
