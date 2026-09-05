import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Payer, Seller, SellerPayerLink } from "../generated/schema";

export function loadSeller(addr: Bytes, now: BigInt): Seller {
  let s = Seller.load(addr);
  if (s == null) {
    s = new Seller(addr);
    s.domain = null;
    s.latestAttestation = null;
    s.totalVolume = BigInt.zero();
    s.benchmarkedVolume = BigInt.zero();
    s.weightedSlipTenthBp = BigInt.zero();
    s.settlementCount = 0;
    s.syntheticVolume = BigInt.zero();
    s.distinctPayers = 0;
    s.distinctHumans = 0;
    s.firstSeen = now;
    s.lastSeen = now;
  }
  return s as Seller;
}

export function loadPayer(addr: Bytes, now: BigInt): Payer {
  let p = Payer.load(addr);
  if (p == null) {
    p = new Payer(addr);
    p.humanId = null;
    p.totalVolume = BigInt.zero();
    p.benchmarkedVolume = BigInt.zero();
    p.weightedSlipTenthBp = BigInt.zero();
    p.settlementCount = 0;
    p.syntheticVolume = BigInt.zero();
    p.firstSeen = now;
    p.lastSeen = now;
  }
  return p as Payer;
}

/**
 * Count a payer against a seller exactly once.
 *
 * `distinctPayers` is set cardinality, and a handler cannot hold a set between
 * invocations — the store is the only memory a mapping has. An immutable link
 * entity keyed on (seller, payer) is that set: its existence is the membership
 * test, and creating it twice is harmless.
 */
export function linkSellerPayer(seller: Seller, payer: Payer): void {
  const id = seller.id.concat(payer.id);
  if (SellerPayerLink.load(id) != null) return;
  const link = new SellerPayerLink(id);
  link.seller = seller.id;
  link.payer = payer.id;
  link.save();
  seller.distinctPayers = seller.distinctPayers + 1;
  if (payer.humanId !== null) {
    seller.distinctHumans = seller.distinctHumans + 1;
  }
}
