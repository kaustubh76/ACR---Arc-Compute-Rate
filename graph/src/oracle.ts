import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import { PricePosted as PricePostedV1 } from "../generated/ACROracle/ACROracle";
import { PricePosted as PricePostedV2 } from "../generated/ACROracleV2/ACROracleV2";
import { EconomicPrint, Print } from "../generated/schema";
import { decodeIndexId } from "./indices";
import { loadRing, pushPrint } from "./tca";

/**
 * ACROracle v1 carries six signed fields; policyHash, humanAdjustedBound and
 * the window bounds arrive only with v2, so they stay null here rather than
 * being defaulted to zero — "not carried by this oracle" and "zero" are
 * different facts and a rating must not read one as the other.
 */
export function handlePricePosted(event: PricePostedV1): void {
  upsert(
    event.transaction.hash.concatI32(event.logIndex.toI32()),
    decodeIndexId(event.params.indexId),
    1,
    event.address,
    event.params.signer,
    event.params.value,
    event.params.ciLo,
    event.params.ciHi,
    event.params.attackCostPerBp,
    null, null, null, null,
    event.params.timestamp,
    event.block.timestamp,
    event.block.number,
    event.params.indexId
  );
}

/** v2: the same print, plus the four facts that make it reproducible. */
export function handlePricePostedV2(event: PricePostedV2): void {
  upsert(
    event.transaction.hash.concatI32(event.logIndex.toI32()),
    decodeIndexId(event.params.indexId),
    2,
    event.address,
    event.params.signer,
    event.params.value,
    event.params.ciLo,
    event.params.ciHi,
    event.params.attackCostPerBp,
    // A zero human bound is the "not computed" sentinel the contract enforces,
    // so it is stored as null here — the tape must not publish "costs nothing"
    // where the truth is "we have not measured it".
    event.params.humanAdjustedBound.isZero() ? null : event.params.humanAdjustedBound,
    event.params.policyHash,
    event.params.windowStart,
    event.params.windowEnd,
    event.params.timestamp,
    event.block.timestamp,
    event.block.number,
    event.params.indexId
  );
}

function upsert(
  id: Bytes,
  index: string,
  version: i32,
  oracle: Bytes,
  signer: Bytes,
  value: BigInt,
  ciLo: BigInt,
  ciHi: BigInt,
  attackCost: BigInt,
  humanBound: BigInt | null,
  policyHash: Bytes | null,
  windowStart: BigInt | null,
  windowEnd: BigInt | null,
  timestamp: BigInt,
  postedAt: BigInt,
  block: BigInt,
  indexId: Bytes
): void {
  const epId = index + "-" + timestamp.toString();

  // 1. The immutable per-log record. Always written: each oracle's posting is
  //    independently auditable, with its own tx hash.
  const print = new Print(id);
  print.economic = epId;
  print.index = index;
  print.indexId = indexId;
  print.value = value;
  print.ciLo = ciLo;
  print.ciHi = ciHi;
  print.attackCostPerBp = attackCost;
  print.timestamp = timestamp;
  print.postedAt = postedAt;
  print.signer = signer;
  print.oracle = oracle;
  print.oracleVersion = version;
  print.policyHash = policyHash;
  print.humanAdjustedBound = humanBound;
  print.windowStart = windowStart;
  print.windowEnd = windowEnd;
  print.block = block;
  print.save();

  // 2. The deduplicated economic print.
  let ep = EconomicPrint.load(epId);
  const isFirst = ep == null;
  if (isFirst) {
    ep = new EconomicPrint(epId);
    ep.index = index;
    ep.timestamp = timestamp;
    // FIRST POSTING ONLY. Never rewritten by the second oracle: moving it
    // would move which print a settlement between the two postings is
    // benchmarked against, and a deployment choice must not move a
    // payer-facing number.
    ep.postedAt = postedAt;
    ep.value = value;
    ep.ciLo = ciLo;
    ep.ciHi = ciHi;
    ep.attackCostPerBp = attackCost;
    ep.oracleMask = 0;
    ep.divergent = false;
  } else if (
    !ep!.value.equals(value) ||
    !ep!.ciLo.equals(ciLo) ||
    !ep!.ciHi.equals(ciHi) ||
    !ep!.attackCostPerBp.equals(attackCost)
  ) {
    // Two independently signed oracles disagreeing about one economic print is
    // evidence, not noise — and the only automatic detector for a mis-scaled
    // v2 payload. Recorded; never resolved by picking a winner.
    ep!.divergent = true;
    log.warning("divergent print {}: v{} says {}, first posting said {}", [
      epId, version.toString(), value.toString(), ep!.value.toString(),
    ]);
  }

  // v2-only fields are ADDITIVE — a later posting may add them, never overwrite
  // what the first one established.
  if (version == 2) {
    ep!.humanAdjustedBound = humanBound;
    ep!.policyHash = policyHash;
    ep!.windowStart = windowStart;
    ep!.windowEnd = windowEnd;
  }
  ep!.oracleMask = ep!.oracleMask | (version == 1 ? 1 : 2);
  ep!.save();

  // 3. The arrival ring. Only a genuinely NEW economic print pushes a slot: the
  //    other oracle's mirror of one that already exists must not, or the ring's
  //    usable depth halves and a settlement between the two postings gets
  //    benchmarked against the wrong hour.
  if (isFirst) {
    const ring = loadRing(index);
    pushPrint(ring, print);
    ring.save();
  }
}
