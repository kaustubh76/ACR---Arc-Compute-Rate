/* Pure codec for ACRFutures reads: series/position descaling and the
   per-index series selection rule. No imports beyond types, no I/O —
   unit-tested in futuresCodec.test.ts. Mirrors the Python reference in
   packages/acr_oracle_client/acr_oracle_client/futures.py (descale_series,
   descale_position, select_series_for_index, recent_trades) so the direct
   viem tier and the FastAPI press can never disagree on shapes. The viem
   wiring lives in lib/futuresOnchain.ts (server-only). */

import { fromUsdc6, fromWad } from "./onchainCodec";
import type { FuturesDeskRow, FuturesTradeRow } from "./types";

/** Decode a right-null-padded bytes32 index id back to its string —
 *  inverse of onchainCodec.indexIdBytes32 / Python bytes32_to_index_id. */
export function bytes32ToIndexId(hex: `0x${string}`): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 2) {
    const b = parseInt(body.slice(i, i + 2), 16);
    if (Number.isNaN(b)) break;
    bytes.push(b);
  }
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return new TextDecoder().decode(new Uint8Array(bytes.slice(0, end)));
}

/** The Series struct as viem decodes it (named tuple components). */
export interface RawSeries {
  indexId: `0x${string}`;
  expiryTs: bigint;
  multiplier: bigint;
  maker: `0x${string}`;
  exists: boolean;
  settled: boolean;
  settlementPrice: bigint;
}

/** The Position struct as viem decodes it. */
export interface RawPosition {
  contracts: bigint;
  avgPrice: bigint;
  realizedPnl: bigint;
}

/** A decoded series row (human units) — Python descale_series. */
export interface SeriesInfo {
  series_id: number;
  index_id: string;
  expiry_ts: number;
  multiplier: number;
  maker: string;
  exists: boolean;
  settled: boolean;
  settlement_price: number;
}

export function decodeSeries(seriesId: number, s: RawSeries): SeriesInfo {
  return {
    series_id: seriesId,
    index_id: bytes32ToIndexId(s.indexId),
    expiry_ts: Number(s.expiryTs),
    multiplier: Number(s.multiplier),
    maker: s.maker,
    exists: s.exists,
    settled: s.settled,
    settlement_price: s.settlementPrice ? fromWad(s.settlementPrice) : 0,
  };
}

/** Pick the series to show for an index: the latest un-settled one, else the
 *  latest settled one (so a just-expired series still renders until replaced).
 *  EXACT mirror of Python select_series_for_index. */
export function selectSeriesForIndex(
  series: SeriesInfo[],
  indexId: string,
): SeriesInfo | null {
  const matching = series.filter((s) => s.index_id === indexId && s.exists);
  if (!matching.length) return null;
  const live = matching.filter((s) => !s.settled);
  const pool = live.length ? live : matching;
  return pool.reduce((a, b) => (b.series_id > a.series_id ? b : a));
}

/** Assemble the desk row the press's FuturesReader emits — Python read_desk:
 *  realized PnL applies the series multiplier to the WAD value·contracts the
 *  contract stores; unrealized comes back USDC-6 from unrealizedPnl(). */
export function buildDeskRow(
  s: SeriesInfo,
  pos: RawPosition,
  upnlUsdc6: bigint,
  traderCount: bigint,
): FuturesDeskRow {
  const inventory = fromWad(pos.contracts);
  return {
    series_id: s.series_id,
    index_id: s.index_id,
    expiry_ts: s.expiry_ts,
    multiplier: s.multiplier,
    maker: s.maker,
    settled: s.settled,
    settlement_price: s.settlement_price,
    maker_inventory: inventory,
    maker_avg_price: fromWad(pos.avgPrice),
    maker_realized_usdc: fromWad(pos.realizedPnl) * s.multiplier,
    maker_unrealized_usdc: fromUsdc6(upnlUsdc6),
    open_interest: Math.abs(inventory),
    trader_count: Number(traderCount),
  };
}

/** One decoded `Traded` log → tape row (Python recent_trades). */
export function decodeTraded(
  seriesId: bigint,
  taker: string,
  qty: bigint,
  mark: bigint,
  block: bigint,
  tx: string,
  seenAt: number,
): FuturesTradeRow {
  const q = fromWad(qty);
  return {
    series_id: Number(seriesId),
    taker,
    qty: q,
    side: q > 0 ? "buy" : "sell",
    mark: fromWad(mark),
    block: Number(block),
    tx,
    seen_at: seenAt,
  };
}
