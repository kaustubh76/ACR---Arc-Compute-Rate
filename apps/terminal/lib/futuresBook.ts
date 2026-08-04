/* Every pure decision the futures surfaces make.
 *
 * Extracted rather than inlined because `npm test` runs ONLY lib/*.test.ts —
 * arithmetic that lives inside a .tsx is arithmetic nobody can assert on. The
 * precedent is lib/deskPhase.ts, whose one function was wrong for the most
 * ordinary case there is until it had a test.
 *
 * Two of these exist because the UI was already lying: `formatQty` (a 0.25
 * contract fill rendered as "BUY 0") and `contractNotional` (the page claimed
 * $1,000 a contract when the live series says $4.95).
 */

import type { FuturesRoster, FuturesTradeRow } from "./types";

const LOCALE = "en-US";

/** A fill size, honestly.
 *
 *  The tape rendered `Math.abs(qty).toFixed(0)`, so the venue's real 0.25 and
 *  0.81 contract fills printed as "0" and "1" — the public tape said BUY 0.
 *  Integers stay bare (a 2 is a 2, not a 2.00); fractions keep two places; and
 *  anything smaller than a cent of a contract says so rather than rounding to
 *  the zero that started this.
 */
export function formatQty(q: number): string {
  const a = Math.abs(q);
  if (!Number.isFinite(a) || a === 0) return "0";
  if (a < 0.01) return "<0.01";
  return Number.isInteger(a) ? String(a) : a.toFixed(2);
}

/** What one contract is worth, in USDC, at a given mark.
 *
 *  ACRFutures.sol:84 defines the series multiplier as "USDC per 1.0 of index
 *  value per contract (e.g. 1000)" — and the terminal hard-coded that EXAMPLE
 *  as fact. The live series runs multiplier 10, so a contract is worth about
 *  $4.95, not $1,000: a 200x overstatement on the page a judge reads, with the
 *  right number sitting unused in the same payload.
 *
 *  Returns null rather than 0 when either input is missing, so a caller must
 *  choose a sentence that does not quote a figure. A confident zero would be
 *  the same class of mistake as the constant it replaces.
 */
export function contractNotional(mark: number, multiplier: number): number | null {
  if (!(mark > 0) || !(multiplier > 0)) return null;
  return mark * multiplier;
}

/** A series expiry as an absolute UTC date.
 *
 *  Safe to render as a date — unlike a print's `ts`, which is SIM-seconds and
 *  must never be (lib/format.ts:1). Fixed locale + explicit UTC so the server
 *  and the client agree; a hydration mismatch here would flip the whole page.
 */
export function expiryLabel(expiryTs: number): string {
  if (!(expiryTs > 0)) return "—";
  const d = new Date(expiryTs * 1000);
  const date = d.toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const time = d.toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `${date} · ${time} UTC`;
}

/** How far a fill traded from the rate it will settle against, in basis points.
 *
 *  The one sentence a futures chart exists to say: a cash-settled contract is
 *  only interesting in relation to its settlement price.
 */
export function basisBp(mark: number, oracle: number): number | null {
  if (!(oracle > 0) || !Number.isFinite(mark)) return null;
  return (1e4 * (mark - oracle)) / oracle;
}

/** The fills of ONE series, oldest first, deduped.
 *
 *  The tape arrives newest-first (futuresOnchain.ts reverses it), which is
 *  right for a marquee and backwards for a chart — the same inversion
 *  FuturesDesk's inventoryPath already has to undo. Sorted by BLOCK, not by
 *  seen_at: in the archived bundle every trade carries the identical seen_at
 *  (the snapshot stamp), so a wall-clock sort collapses the whole series into
 *  one column, while block is genuinely monotone.
 */
export function markSeries(trades: FuturesTradeRow[], seriesId: number): FuturesTradeRow[] {
  const seen = new Set<string>();
  const rows: FuturesTradeRow[] = [];
  for (const t of trades ?? []) {
    if (t.series_id !== seriesId || seen.has(t.tx)) continue;
    seen.add(t.tx);
    rows.push(t);
  }
  return rows.sort((a, b) => a.block - b.block);
}

/** Which tier of the connection ladder served the desk.
 *
 *  Every other surface on this site says where its numbers came from; the desk
 *  read `source` only as a boolean and told the reader nothing. A direct read
 *  of ACRFutures is still LIVE — more direct than the press, in fact — so it
 *  gets its own chip rather than being lumped in with the archive.
 *
 *  An older proxy may omit `source` entirely; absent is not "archived", so it
 *  defers to the envelope's own liveness.
 */
export function deskTier(
  source: FuturesRoster["source"],
  live: boolean,
): { x: string; p: string; chip: "chip-teal" | "chip-gold" | "chip-sim" } {
  const s = source ?? (live ? "press" : "bundle");
  if (s === "chain") {
    return { x: "read direct from the venue", p: "read straight off the blockchain", chip: "chip-gold" };
  }
  if (s === "bundle") {
    return { x: "archived edition", p: "a saved copy", chip: "chip-sim" };
  }
  return { x: "live from the press", p: "live from our server", chip: "chip-teal" };
}

/** The fill to show as a receipt, or null.
 *
 *  A reader's trade is confirmed by watching their position move, which gives
 *  no transaction. Their own fills are one indexed getLogs away — but the log
 *  window reaches back hours, so the newest row is only THIS trade's receipt if
 *  it differs from the newest row seen before the trade started. Without that
 *  comparison a quiet desk would hand every reader the same stale hash and call
 *  it their receipt.
 */
export function newestFillSince(
  beforeTx: string | null,
  fills: FuturesTradeRow[],
): FuturesTradeRow | null {
  const sorted = [...(fills ?? [])].sort((a, b) => b.block - a.block);
  const newest = sorted[0];
  if (!newest) return null;
  return newest.tx === beforeTx ? null : newest;
}

/** Two-sided book capacity as bar widths, plus whether a side is shut.
 *
 *  max_buy/max_sell are what the contract will actually fill — the desk already
 *  fetches them to size its buttons and then throws the shape away. Drawing it
 *  makes visible the failure that once froze this venue for eleven hours: the
 *  maker drifted short against its margin cap, max_buy went to 0, and every
 *  trade reverted while the page still showed a healthy-looking button.
 */
export function headroomBar(
  maxBuy: number,
  maxSell: number,
  cap = 2.0,
): { buyPct: number; sellPct: number; frozen: boolean } {
  const clamp = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(cap, v)) : 0);
  const b = clamp(maxBuy);
  const s = clamp(maxSell);
  return {
    buyPct: cap > 0 ? (100 * b) / cap : 0,
    sellPct: cap > 0 ? (100 * s) / cap : 0,
    frozen: b <= 0 || s <= 0,
  };
}
