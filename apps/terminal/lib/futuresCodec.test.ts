import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeskRow,
  bytes32ToIndexId,
  decodeSeries,
  decodeTraded,
  selectSeriesForIndex,
  type SeriesInfo,
} from "./futuresCodec";
import { indexIdBytes32 } from "./onchainCodec";

const WAD = 10n ** 18n;

function series(over: Partial<SeriesInfo>): SeriesInfo {
  return {
    series_id: 0,
    index_id: "ACR-INF",
    expiry_ts: 1_800_000_000,
    multiplier: 10,
    maker: "0xmaker",
    exists: true,
    settled: false,
    settlement_price: 0,
    ...over,
  };
}

test("bytes32ToIndexId inverts the poster's encoding", () => {
  for (const id of ["ACR-INF", "ACR-GPU", "ACR-DATA"]) {
    assert.equal(bytes32ToIndexId(indexIdBytes32(id)), id);
  }
});

test("decodeSeries descales like python descale_series", () => {
  const s = decodeSeries(3, {
    indexId: indexIdBytes32("ACR-GPU"),
    expiryTs: 1_800_000_000n,
    multiplier: 10n,
    maker: "0x00000000000000000000000000000000000000aa",
    exists: true,
    settled: true,
    settlementPrice: 25n * 10n ** 14n, // 0.0025 WAD
  });
  assert.equal(s.series_id, 3);
  assert.equal(s.index_id, "ACR-GPU");
  assert.equal(s.expiry_ts, 1_800_000_000);
  assert.equal(s.multiplier, 10);
  assert.equal(s.settled, true);
  assert.equal(s.settlement_price, 0.0025);
});

test("selectSeriesForIndex prefers the latest un-settled series", () => {
  const pool = [
    series({ series_id: 0, settled: true }),
    series({ series_id: 1 }),
    series({ series_id: 2, settled: true }), // newer but settled — must lose
  ];
  assert.equal(selectSeriesForIndex(pool, "ACR-INF")?.series_id, 1);
});

test("selectSeriesForIndex falls back to the latest settled series", () => {
  const pool = [
    series({ series_id: 0, settled: true }),
    series({ series_id: 4, settled: true }),
  ];
  assert.equal(selectSeriesForIndex(pool, "ACR-INF")?.series_id, 4);
});

test("selectSeriesForIndex ignores non-existent series and other indices", () => {
  const pool = [
    series({ series_id: 0, exists: false }),
    series({ series_id: 1, index_id: "ACR-GPU" }),
  ];
  assert.equal(selectSeriesForIndex(pool, "ACR-INF"), null);
  assert.equal(selectSeriesForIndex([], "ACR-INF"), null);
});

test("buildDeskRow matches python read_desk scaling", () => {
  const row = buildDeskRow(
    series({ series_id: 2, multiplier: 10 }),
    {
      contracts: -3n * WAD, // maker short 3
      avgPrice: 25n * 10n ** 14n, // 0.0025
      realizedPnl: 5n * 10n ** 17n, // 0.5 WAD → ×10 multiplier = 5 USDC
    },
    -1_250_000n, // −1.25 USDC unrealized
    2n,
  );
  assert.equal(row.series_id, 2);
  assert.equal(row.maker_inventory, -3);
  assert.equal(row.open_interest, 3); // |inventory|, sign-independent
  assert.equal(row.maker_avg_price, 0.0025);
  assert.equal(row.maker_realized_usdc, 5);
  assert.equal(row.maker_unrealized_usdc, -1.25);
  assert.equal(row.trader_count, 2);
  assert.ok(!("exists" in row));
});

test("realized PnL scales by the SERIES multiplier, not a placeholder 1", () => {
  // The trap under the Public Desk's realized-PnL figure. `readTraderPosition`
  // built its synthetic series with `multiplier: 1`, so a reader's banked PnL
  // came back a tenth of the truth on the live 10x series — while unrealized,
  // which arrives already scaled from `unrealizedPnl`, looked perfectly fine.
  // That asymmetry is why nobody noticed, so it gets a test rather than a
  // comment.
  const pos = {
    contracts: 0n,
    avgPrice: 0n,
    realizedPnl: 6_522_430_415_946_348n, // 0.00652243 WAD, the live maker's
  };
  const real = buildDeskRow(series({ multiplier: 10 }), pos, 0n, 0n);
  const wrong = buildDeskRow(series({ multiplier: 1 }), pos, 0n, 0n);
  // The exact figure the venue reports for this maker, to the last place.
  assert.ok(Math.abs(real.maker_realized_usdc - 0.06522430415946348) < 1e-12);
  assert.ok(Math.abs(wrong.maker_realized_usdc * 10 - real.maker_realized_usdc) < 1e-9);
});

test("decodeTraded derives side from the qty sign", () => {
  const buy = decodeTraded(1n, "0xtaker", 2n * WAD, 25n * 10n ** 14n, 123n, "0xtx", 1_700_000_000);
  assert.equal(buy.side, "buy");
  assert.equal(buy.qty, 2);
  assert.equal(buy.mark, 0.0025);
  assert.equal(buy.block, 123);
  assert.equal(buy.seen_at, 1_700_000_000);

  const sell = decodeTraded(1n, "0xtaker", -1n * WAD, WAD, 124n, "0xtx2", 0);
  assert.equal(sell.side, "sell");
  assert.equal(sell.qty, -1);
});
