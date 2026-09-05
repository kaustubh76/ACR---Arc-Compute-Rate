import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { PayerDay, SellerDay, Settlement } from "../generated/schema";

const ZERO = BigInt.zero();
const DAY = BigInt.fromI32(86400);
/** 10,000 bp = 100,000 tenth-bp. */
const TENTH_BP = BigInt.fromI32(100000);

/** Days since the unix epoch — the bucket key both rollups share. */
export function dayOf(blockTime: BigInt): i32 {
  return blockTime.div(DAY).toI32();
}

function loadSellerDay(seller: Bytes, day: i32): SellerDay {
  const id = seller.toHexString() + "-" + day.toString();
  let d = SellerDay.load(id);
  if (d != null) return d as SellerDay;
  d = new SellerDay(id);
  d.seller = seller;
  d.day = day;
  d.dayStart = BigInt.fromI32(day).times(DAY);
  d.volume = ZERO;
  d.bmVolume = ZERO;
  d.wSlipTenthBp = ZERO;
  d.humanVolume = ZERO;
  d.synthVolume = ZERO;
  d.realVolume = ZERO;
  d.n = 0;
  d.nAll = 0;
  d.nStale = 0;
  d.b0 = 0; d.b1 = 0; d.b2 = 0; d.b3 = 0; d.b4 = 0; d.b5 = 0; d.b6 = 0;
  return d as SellerDay;
}

function loadPayerDay(payer: Bytes, day: i32): PayerDay {
  const id = payer.toHexString() + "-" + day.toString();
  let d = PayerDay.load(id);
  if (d != null) return d as PayerDay;
  d = new PayerDay(id);
  d.payer = payer;
  d.day = day;
  d.dayStart = BigInt.fromI32(day).times(DAY);
  d.spent = ZERO;
  d.bmSpent = ZERO;
  d.wSlipTenthBp = ZERO;
  d.overpay = ZERO;
  d.n = 0;
  d.nAll = 0;
  return d as PayerDay;
}

/**
 * Fold one finalized settlement into its seller's and payer's day.
 *
 * `bucket` is the histogram slot the slippage falls in, or -1 when the
 * settlement carried no benchmark. An unbenchmarked settlement must fire NO
 * bucket: landing it in b2 would inflate the "priced fairly" bucket with rows
 * that never had a price to compare against, which is exactly the reading a
 * seller grade would then be built on.
 */
export function rollUp(
  s: Settlement,
  blockTime: BigInt,
  benchmarked: boolean,
  slipTenth: BigInt,
  bucket: i32
): void {
  const day = dayOf(blockTime);

  const sd = loadSellerDay(s.seller, day);
  sd.volume = sd.volume.plus(s.amount);
  sd.nAll = sd.nAll + 1;
  if (s.synthetic) {
    sd.synthVolume = sd.synthVolume.plus(s.amount);
  } else {
    sd.realVolume = sd.realVolume.plus(s.amount);
  }
  if (s.human) sd.humanVolume = sd.humanVolume.plus(s.amount);
  if (s.staleArrival) sd.nStale = sd.nStale + 1;
  if (benchmarked) {
    sd.bmVolume = sd.bmVolume.plus(s.amount);
    sd.wSlipTenthBp = sd.wSlipTenthBp.plus(s.amount.times(slipTenth));
    sd.n = sd.n + 1;
    if (bucket == 0) sd.b0 = sd.b0 + 1;
    else if (bucket == 1) sd.b1 = sd.b1 + 1;
    else if (bucket == 2) sd.b2 = sd.b2 + 1;
    else if (bucket == 3) sd.b3 = sd.b3 + 1;
    else if (bucket == 4) sd.b4 = sd.b4 + 1;
    else if (bucket == 5) sd.b5 = sd.b5 + 1;
    else if (bucket == 6) sd.b6 = sd.b6 + 1;
  }
  sd.save();

  const pd = loadPayerDay(s.payer, day);
  pd.spent = pd.spent.plus(s.amount);
  pd.nAll = pd.nAll + 1;
  if (benchmarked) {
    pd.bmSpent = pd.bmSpent.plus(s.amount);
    pd.wSlipTenthBp = pd.wSlipTenthBp.plus(s.amount.times(slipTenth));
    pd.n = pd.n + 1;
    // Overpay counts only what was paid ABOVE arrival: netting the good fills
    // against the bad would answer a different question than "what did being
    // wrong cost me". Integer division, here, not inside a Postgres `arg`.
    if (slipTenth.gt(ZERO)) {
      pd.overpay = pd.overpay.plus(s.amount.times(slipTenth).div(TENTH_BP));
    }
  }
  pd.save();
}
