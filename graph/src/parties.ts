import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  HumanCluster,
  Payer,
  Seller,
  SellerPayerLink,
  SellerWindow,
  SellerWindowHuman,
  SellerWindowPayer,
} from "../generated/schema";

/**
 * The rotation window, in seconds — and it MUST equal
 * `HumanIdMirror.RATING_WINDOW`. A cluster id is minted for one window; if this
 * constant disagreed with the contract's, the mapping would look for a cluster
 * in a window the resolver never wrote one for and every payer would silently
 * read as non-human. `tests/humanid.test.ts` pins it, and a Python test pins the
 * same number against the Solidity source.
 */
export const RATING_WINDOW = BigInt.fromI32(604800); // 7 days

export function windowOf(blockTime: BigInt): BigInt {
  return blockTime.div(RATING_WINDOW);
}

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
    s.firstSeen = now;
    s.lastSeen = now;
  }
  return s as Seller;
}

export function loadPayer(addr: Bytes, now: BigInt): Payer {
  let p = Payer.load(addr);
  if (p == null) {
    p = new Payer(addr);
    p.cluster = null;
    p.clusterWindow = null;
    p.resolvedLate = false;
    p.lastSettledWindow = null;
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

export function loadHumanCluster(
  id: Bytes,
  window: BigInt,
  sandbox: boolean,
  now: BigInt
): HumanCluster {
  let c = HumanCluster.load(id);
  if (c == null) {
    c = new HumanCluster(id);
    c.window = window;
    c.sandbox = sandbox;
    c.walletCount = 0;
    c.firstSeen = now;
  }
  return c as HumanCluster;
}

/**
 * This payer's cluster for `window`, or null.
 *
 * A cluster is only meaningful inside the window it was minted for: the payer
 * carries the most recent one, so a stored cluster from LAST window must read as
 * null here rather than quietly making the payer look human-backed forever.
 */
export function clusterFor(payer: Payer, window: BigInt): Bytes | null {
  const w = payer.clusterWindow;
  if (w === null) return null;
  if (!w!.equals(window)) return null;
  return payer.cluster;
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
}

function loadSellerWindow(seller: Bytes, window: BigInt): SellerWindow {
  const id = seller.toHexString() + "-" + window.toString();
  let w = SellerWindow.load(id);
  if (w != null) return w as SellerWindow;
  w = new SellerWindow(id);
  w.seller = seller;
  w.window = window;
  w.windowStart = window.times(RATING_WINDOW);
  w.volume = BigInt.zero();
  w.humanVolume = BigInt.zero();
  w.distinctPayers = 0;
  w.distinctHumans = 0;
  w.sandboxHumans = 0;
  return w as SellerWindow;
}

/**
 * Fold one settlement into its seller's ROTATION window.
 *
 * Volumes roll up daily in `rollUp`; this exists for the counts that cannot be
 * summed across buckets. One human trading on three days is one human, so
 * `distinctHumans` is only meaningful inside a single window — and because a
 * cluster id is minted per window, distinct clusters here IS distinct humans,
 * with no double counting to correct for afterwards.
 *
 * A payer with no cluster for THIS window contributes to `distinctPayers` and
 * `volume` but not to the human counts. That is the honest reading: unresolved
 * is not the same fact as resolved-and-not-human.
 */
export function linkSellerWindow(seller: Seller, payer: Payer, blockTime: BigInt, amount: BigInt): void {
  const window = windowOf(blockTime);
  const sw = loadSellerWindow(seller.id, window);
  sw.volume = sw.volume.plus(amount);

  const payerKey =
    seller.id.toHexString() + "-" + window.toString() + "-" + payer.id.toHexString();
  if (SellerWindowPayer.load(payerKey) == null) {
    const seen = new SellerWindowPayer(payerKey);
    seen.save();
    sw.distinctPayers = sw.distinctPayers + 1;
  }

  const cluster = clusterFor(payer, window);
  if (cluster !== null) {
    sw.humanVolume = sw.humanVolume.plus(amount);
    // The cluster already encodes its window, so seller ++ cluster is unique
    // per window without restating it.
    const humanKey = seller.id.toHexString() + "-" + cluster.toHexString();
    if (SellerWindowHuman.load(humanKey) == null) {
      const seen = new SellerWindowHuman(humanKey);
      seen.save();
      sw.distinctHumans = sw.distinctHumans + 1;
      // Counted alongside, never instead: a rating that showed a human count
      // without saying how much of it is demo would be the same overclaim the
      // synthetic share exists to prevent on the flow side.
      const hc = HumanCluster.load(cluster);
      if (hc !== null && hc.sandbox) {
        sw.sandboxHumans = sw.sandboxHumans + 1;
      }
    }
  }

  sw.save();
}
