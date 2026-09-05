import { BigInt } from "@graphprotocol/graph-ts";
import {
  SettlementOpened,
  SettlementFinalized,
} from "../generated/ReceiptMirror/ReceiptMirror";
import {
  PendingSettlement,
  Print,
  Settlement,
} from "../generated/schema";
import { decodeIndexId } from "./indices";
import {
  bucketOf,
  divRound,
  loadRing,
  pickArrival,
  unbenchmarkedReason,
} from "./tca";
import { loadPayer, loadSeller, linkSellerPayer } from "./parties";
import { rollUp } from "./rollup";

const ZERO = BigInt.zero();
const TENTH_BP = BigInt.fromI32(100000); // 10,000 bp = 100,000 tenth-bp
/** amountUsdc is 1e6 and quantity is WAD 1e18, so a WAD unit price needs 1e30. */
const E30 = BigInt.fromString("1000000000000000000000000000000");
/** ACRFutures.MAX_SETTLE_AGE — the venue's own definition of a stale print. */
const STALE_ARRIVAL_S = BigInt.fromI32(7200);

/**
 * Phase 1 — the arrival anchor.
 *
 * Everything price-relevant about this settlement is decided here, as a function
 * of `settledAt`, which the keeper committed on chain BEFORE the quantity (and
 * therefore the unit price) was known. A keeper that mirrors late cannot change
 * which print it is measured against; it can only make its own lateness visible.
 */
export function handleSettlementOpened(event: SettlementOpened): void {
  const index = decodeIndexId(event.params.indexId);
  const settledAt = event.params.settledAt;

  const ps = new PendingSettlement(event.params.settlementId);
  ps.payer = event.params.payer;
  ps.seller = event.params.seller;
  ps.amount = event.params.amountUsdc;
  ps.gatewayRef = event.params.gatewayRef;
  ps.settledAt = settledAt;
  ps.mirrorLagSeconds = event.params.mirrorLagSeconds;
  ps.late = event.params.late;
  ps.index = index;
  ps.synthetic = event.params.synthetic;
  ps.finalized = false;
  ps.blockTime = event.block.timestamp;

  const ring = loadRing(index);
  const i = pickArrival(ring, settledAt);
  if (i < 0) {
    ps.benchmarked = false;
    ps.unbenchmarkedReason = unbenchmarkedReason(ring);
  } else {
    ps.benchmarked = true;
    ps.arrivalPrint = ring.printIds[i];
    ps.arrivalValue = ring.values[i];
    ps.arrivalAgeSeconds = settledAt.minus(ring.postedAts[i]);
    // The CI bounds are not denormalised onto the ring — they are only read on
    // the rare query that wants them, so one load here beats three more arrays
    // rewritten on every print.
    const arrival = Print.load(ring.printIds[i]);
    if (arrival != null) {
      ps.arrivalCiLow = arrival.ciLo;
      ps.arrivalCiHigh = arrival.ciHi;
    }
  }
  ps.save();
}

/**
 * Phase 2 — the quantity, and with it the unit price and the slippage.
 *
 * Reads the anchor written in phase 1 and never recomputes it: `arrivalPrint`
 * here is whatever `settledAt` selected, even if a dozen prints have landed
 * since. That is the invariant the two-phase write exists to provide.
 */
export function handleSettlementFinalized(event: SettlementFinalized): void {
  const ps = PendingSettlement.load(event.params.settlementId);
  // Finalize-without-open. The contract forbids it, but a mapping that aborts
  // halts indexing on a live subgraph, so drop the event rather than crash.
  if (ps == null) return;
  // Idempotent under a reorg replay: the contract blocks a second finalize, but
  // handlers are re-run on reorgs and double-counting a payer's volume is a
  // silent corruption no query would reveal.
  if (ps.finalized) return;

  const quantity = event.params.quantity;
  const s = new Settlement(event.params.settlementId);
  s.pending = ps.id;
  s.amount = ps.amount;
  s.unit = event.params.unit;
  s.quantity = quantity;
  s.unitPrice = ps.amount.times(E30).div(quantity); // contract rejects quantity 0
  s.index = ps.index;
  s.gatewayRef = ps.gatewayRef;
  s.settledAt = ps.settledAt;
  s.mirrorLagSeconds = ps.mirrorLagSeconds;
  s.finalizeLagSeconds = event.params.finalizeLagSeconds;
  s.late = ps.late;
  s.synthetic = ps.synthetic;
  s.blockTime = event.block.timestamp;
  s.benchmarked = ps.benchmarked;
  s.unbenchmarkedReason = ps.unbenchmarkedReason;
  s.arrivalPrint = ps.arrivalPrint;
  s.arrivalValue = ps.arrivalValue;
  s.arrivalAgeSeconds = ps.arrivalAgeSeconds;
  s.staleArrival =
    ps.arrivalAgeSeconds !== null && ps.arrivalAgeSeconds!.gt(STALE_ARRIVAL_S);

  // Slippage is carried at tenth-bp precision and the displayed bp figure is
  // derived from it — never the other way round, so the volume-weighted mean is
  // not built out of values already rounded to a whole basis point.
  let slipTenth = ZERO;
  let benchmarked = false;
  if (s.benchmarked && ps.arrivalValue !== null && ps.arrivalValue!.gt(ZERO)) {
    benchmarked = true;
    slipTenth = divRound(
      s.unitPrice.minus(ps.arrivalValue!).times(TENTH_BP),
      ps.arrivalValue!
    );
    s.slippageTenthBp = slipTenth;
    s.slippageBp = divRound(slipTenth, BigInt.fromI32(10));
  }

  const payer = loadPayer(ps.payer, event.block.timestamp);
  const seller = loadSeller(ps.seller, event.block.timestamp);
  s.payer = payer.id;
  s.seller = seller.id;
  s.human = payer.humanId !== null;
  s.save();

  ps.finalized = true;
  ps.save();

  payer.totalVolume = payer.totalVolume.plus(s.amount);
  payer.settlementCount = payer.settlementCount + 1;
  payer.lastSeen = event.block.timestamp;
  seller.totalVolume = seller.totalVolume.plus(s.amount);
  seller.settlementCount = seller.settlementCount + 1;
  seller.lastSeen = event.block.timestamp;
  if (s.synthetic) {
    payer.syntheticVolume = payer.syntheticVolume.plus(s.amount);
    seller.syntheticVolume = seller.syntheticVolume.plus(s.amount);
  }
  if (benchmarked) {
    payer.benchmarkedVolume = payer.benchmarkedVolume.plus(s.amount);
    seller.benchmarkedVolume = seller.benchmarkedVolume.plus(s.amount);
    const w = s.amount.times(slipTenth);
    payer.weightedSlipTenthBp = payer.weightedSlipTenthBp.plus(w);
    seller.weightedSlipTenthBp = seller.weightedSlipTenthBp.plus(w);
  }
  payer.save();
  // `distinctPayers` needs set membership, which a handler cannot hold between
  // invocations — an entity is the store's version of a set.
  linkSellerPayer(seller, payer);
  seller.save();

  // ── the daily rollups ─────────────────────────────────────────────────────
  // Accumulated here rather than by `@aggregation`, so every conditional and
  // every division is ordinary AssemblyScript a test can reach. See the note
  // above SellerDay in schema.graphql for why.
  rollUp(
    s,
    event.block.timestamp,
    benchmarked,
    slipTenth,
    benchmarked ? bucketOf(s.slippageBp!) : -1
  );
}
