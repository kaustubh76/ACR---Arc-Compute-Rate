import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Print, PrintRing } from "../generated/schema";

/**
 * How many recent prints per index the ring keeps.
 *
 * Arrival selection has to answer "which print could this payer have seen when
 * they paid?", and a settlement reaches the chain some seconds after it
 * happened — by which time a newer print may have landed.
 *
 * Prints are hourly, so 48 is about two days. The ordinary mirror path is
 * already capped at one hour by `ReceiptMirror.MAX_MIRROR_LAG`, but the
 * owner-only late path is deliberately exempt so an outage costs a label rather
 * than a hole in the tape — and the seller API runs on a free tier that sleeps.
 * Two days covers an overnight backlog plus a weekend.
 *
 * Deliberately not deeper. The ring bounds the CLAIM, not just the work: a
 * settlement whose arrival print is more than two days old is one whose
 * benchmark we should decline to publish, not one to reach further back for.
 * `RING_UNDERFLOW` is the honest answer there.
 */
export const RING_DEPTH = 48;

export const BP = BigInt.fromI32(10000);
/** Prints are WAD 1e18; USDC and unit prices are 1e6. */
export const WAD_PER_USDC6 = BigInt.fromString("1000000000000");

export function loadRing(index: string): PrintRing {
  let ring = PrintRing.load(index);
  if (ring == null) {
    ring = new PrintRing(index);
    ring.printIds = [];
    ring.postedAts = [];
    ring.values = [];
    ring.updatedAt = BigInt.zero();
  }
  return ring as PrintRing;
}

/**
 * Push a print onto the front of its index's ring.
 *
 * Ordering is by `postedAt` (block time of the posting tx), NOT by the print's
 * economic `timestamp`: the economic timestamp is signed off-chain and may lead
 * block time, so it answers "what window is this print about" rather than "when
 * could anyone have read it". Arrival is an observability question.
 *
 * Two oracles post the same index during the v1 -> v2 overlap, so a print may
 * arrive with a `postedAt` at or behind the ring head. Insert by position
 * instead of assuming append-at-front, and let the newer `postedAt` win.
 */
export function pushPrint(ring: PrintRing, print: Print): void {
  const ids = ring.printIds;
  const ats = ring.postedAts;
  const vals = ring.values;

  let at = 0;
  while (at < ats.length && ats[at].gt(print.postedAt)) at++;

  const nextIds = new Array<Bytes>(0);
  const nextAts = new Array<BigInt>(0);
  const nextVals = new Array<BigInt>(0);
  for (let i = 0; i < at; i++) {
    nextIds.push(ids[i]);
    nextAts.push(ats[i]);
    nextVals.push(vals[i]);
  }
  nextIds.push(print.id);
  nextAts.push(print.postedAt);
  nextVals.push(print.value);
  for (let i = at; i < ids.length && nextIds.length < RING_DEPTH; i++) {
    nextIds.push(ids[i]);
    nextAts.push(ats[i]);
    nextVals.push(vals[i]);
  }

  ring.printIds = nextIds;
  ring.postedAts = nextAts;
  ring.values = nextVals;
  if (at == 0) ring.latest = print.id;
  ring.updatedAt = print.postedAt;
}

/**
 * The print a payer could have seen at `settledAt`: the newest one posted at or
 * before that moment.
 *
 * This is the whole write-time correctness argument. The keeper supplies only
 * the settlement's own timestamp — it never supplies a price, and it cannot
 * change which price applies by mirroring late, because selection keys on
 * `settledAt` rather than on the block the mirror landed in.
 *
 * Returns the ring SLOT INDEX, or -1 when no print precedes the settlement —
 * either it predates the feed, or the keeper was down longer than RING_DEPTH
 * prints. Both are `benchmarked: false`, never a silent 0 bp.
 *
 * An index rather than a `Bytes | null`, for two reasons: the caller gets
 * `values[i]` without a second store load, and a nullable `Bytes` cannot be
 * compared against null at all — `ByteArray` overloads `==`, so `hit == null`
 * crashes the AssemblyScript compiler rather than failing to typecheck.
 */
export function pickArrival(ring: PrintRing, settledAt: BigInt): i32 {
  const ats = ring.postedAts;
  for (let i = 0; i < ats.length; i++) {
    if (ats[i].le(settledAt)) return i; // graph-ts BigInt has no <= overload
  }
  return -1;
}

/** Why `pickArrival` found nothing — an outage must never render as market history. */
export function unbenchmarkedReason(ring: PrintRing): string {
  return ring.printIds.length < RING_DEPTH ? "NO_PRINT_YET" : "RING_UNDERFLOW";
}

/** Divide with round-half-away-from-zero, so slippage carries no sign bias. */
export function divRound(num: BigInt, den: BigInt): BigInt {
  if (den.isZero()) return BigInt.zero();
  const neg = num.lt(BigInt.zero()) != den.lt(BigInt.zero());
  const n = num.abs();
  const d = den.abs();
  const q = n.times(BigInt.fromI32(2)).plus(d).div(d.times(BigInt.fromI32(2)));
  return neg ? q.neg() : q;
}

/**
 * Implementation shortfall against arrival, in basis points.
 *
 * `paid` and `arrival` must already be in the same scale. Positive is worse for
 * the payer: they paid above the benchmark.
 */
export function slippageBp(paid: BigInt, arrival: BigInt): BigInt {
  if (arrival.le(BigInt.zero())) return BigInt.zero();
  return divRound(paid.minus(arrival).times(BP), arrival);
}

/** A WAD 1e18 print value in the USDC 1e6 scale unit prices are quoted in. */
export function wadToUsdc6(wad: BigInt): BigInt {
  return divRound(wad, WAD_PER_USDC6);
}

/** Which histogram bucket a slippage falls in — b0..b6, matching SettlementData. */
export function bucketOf(bp: BigInt): i32 {
  const v = bp.toI32();
  if (v < -100) return 0;
  if (v < 0) return 1;
  if (v < 50) return 2;
  if (v < 100) return 3;
  if (v < 200) return 4;
  if (v < 500) return 5;
  return 6;
}
