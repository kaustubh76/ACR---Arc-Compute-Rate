import { BigInt } from "@graphprotocol/graph-ts";
import {
  CollateralPosted,
  CollateralWithdrawn,
  SeriesOpened,
  Settled,
  Traded,
} from "../generated/ACRFutures/ACRFutures";
import { FuturesFill, Series } from "../generated/schema";
import { decodeIndexId } from "./indices";
import { loadRing, pickArrival, slippageBp } from "./tca";
import { recordCollateral } from "./witness";

export function handleSeriesOpened(event: SeriesOpened): void {
  const s = new Series(event.params.seriesId.toString());
  s.seriesId = event.params.seriesId;
  s.index = decodeIndexId(event.params.indexId);
  s.expiryTs = event.params.expiryTs;
  s.multiplier = event.params.multiplier;
  s.maker = event.params.maker;
  s.settled = false;
  s.settlementPrice = null;
  s.fillCount = 0;
  s.openedAt = event.block.timestamp;
  s.save();
}

/**
 * A real on-chain fill: real taker, real USDC collateral, no keeper, no mirror,
 * no synthetic flag. This is the tape that proves the pipeline indexes genuine
 * economic activity before any mirrored settlement exists.
 *
 * On its slippage, stated plainly rather than dressed up: `ACRFutures.trade`
 * fills at `oracle.latestValue(indexId)` (ACRFutures.sol:244) — the fill price
 * IS the prevailing print. So implementation shortfall against arrival is zero
 * *by construction*, and that zero is a true measurement of the venue, not a
 * TCA signal. It is recorded here and deliberately NOT written into
 * SettlementData: letting structural zeros into the aggregations would flatter
 * every seller rating with fills that could never have shown slippage.
 */
export function handleTraded(event: Traded): void {
  const series = Series.load(event.params.seriesId.toString());
  const index = series == null ? "" : series.index;

  const id = event.transaction.hash.concatI32(event.logIndex.toI32());
  const fill = new FuturesFill(id);
  fill.seriesId = event.params.seriesId;
  fill.series = series == null ? null : series.id;
  fill.index = index;
  fill.taker = event.params.taker;
  fill.qty = event.params.qty;
  fill.mark = event.params.mark;
  fill.blockTime = event.block.timestamp;
  fill.block = event.block.number;

  fill.benchmarked = false;
  fill.slippageBp = null;
  fill.arrivalPrint = null;

  if (index != "") {
    const ring = loadRing(index);
    const i = pickArrival(ring, event.block.timestamp);
    if (i >= 0) {
      fill.arrivalPrint = ring.printIds[i];
      fill.benchmarked = true;
      // Reads the ring's denormalised value — no second store load, and it is
      // the same number the arrival slot was written with.
      fill.slippageBp = slippageBp(event.params.mark, ring.values[i]);
    }
  }
  fill.save();

  if (series != null) {
    series.fillCount = series.fillCount + 1;
    series.save();
  }
}

export function handleSettled(event: Settled): void {
  const s = Series.load(event.params.seriesId.toString());
  if (s == null) return;
  s.settled = true;
  s.settlementPrice = event.params.settlementPrice;
  s.save();
}

// Money entering and leaving the book. `Series.fillCount` says trades happened;
// only these say anyone funded them or was paid out.
export function handleCollateralPosted(event: CollateralPosted): void {
  recordCollateral(
    event, event.params.seriesId.toString(), event.params.trader, event.params.amount, true
  );
}
export function handleCollateralWithdrawn(event: CollateralWithdrawn): void {
  recordCollateral(
    event, event.params.seriesId.toString(), event.params.trader, event.params.amount, false
  );
}
