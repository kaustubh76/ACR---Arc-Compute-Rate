/* One payment, walked. The decisions only; the reads live in floatOnchain.
 *
 * WHY LOG ORDER IS THE PROOF. Arc's RPC serves no `debug_traceTransaction` and
 * no `trace_*`, so there is no call trace to appeal to. What a just-in-time
 * payment claims is an ORDER — the shortfall came out of the yield venue and
 * then the seller was paid, inside one transaction — and the only witness to
 * that order is the position of the two logs in the same receipt.
 *
 * Ported from `float/app/walk.html`, which Arc Studio wrote and which already
 * had to get the matching right. The three rules worth keeping are its own:
 * match the payment on WHO WAS PAID rather than on position or size, take the
 * pull that most closely precedes the payment rather than the first one, and
 * prefer the receipt that claims to be just-in-time when a transaction carries
 * more than one.
 */

export type WalkLog = {
  /** Position in the transaction's own log list. The whole proof. */
  idx: number;
  addr: string;
  name: string;
  args: Record<string, unknown>;
};

/** Addresses from a node arrive in whatever case the node felt like. */
export function same(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/** The vault's Receipt. Prefers one that claims just-in-time funding, because
 *  that is the claim this walk exists to test. */
export function pickReceipt(logs: readonly WalkLog[], vault: string): WalkLog | null {
  const rs = logs.filter((l) => same(l.addr, vault) && l.name === "Receipt");
  return rs.find((l) => Boolean(l.args.jitFunded)) ?? rs[0] ?? null;
}

/** The USDC transfer that paid the seller.
 *
 *  MATCHED ON `to`, NEVER ON POSITION OR SIZE. A transaction can carry several
 *  USDC transfers and the largest is not reliably the payment; who received it
 *  is the only thing that identifies it. Among transfers to the seller, one
 *  whose value equals the quote is preferred, but any transfer to the seller
 *  beats none. */
export function pickPay(
  logs: readonly WalkLog[],
  usdc: string,
  seller: string,
  quote: bigint | undefined,
): WalkLog | null {
  const toSeller = logs.filter((l) => same(l.addr, usdc) && l.name === "Transfer" && same(String(l.args.to), seller));
  if (quote !== undefined) {
    const exact = toSeller.find((l) => (l.args.value as bigint) === quote);
    if (exact) return exact;
  }
  return toSeller[0] ?? null;
}

/** The sleeve pull that most closely precedes the payment.
 *
 *  The LAST one before the payment, not the first in the transaction: a
 *  rebalance and a just-in-time pull can both appear, and the one that funded
 *  this payment is the one that happened immediately before it. */
export function pickPull(logs: readonly WalkLog[], sleeve: string, payIdx: number | null): WalkLog | null {
  const pulls = logs.filter((l) => same(l.addr, sleeve) && l.name === "Pulled");
  const before = payIdx === null ? pulls : pulls.filter((l) => l.idx < payIdx);
  return before.length ? before[before.length - 1] : (pulls[0] ?? null);
}

export type Verdict = "in_order" | "out_of_order" | "unproven" | "not_jit";

/** Did the pull come before the pay?
 *
 *  FOUR ANSWERS, NOT TWO, and the difference between the last two is the one
 *  that matters. A payment that never claimed to be just-in-time has no order
 *  to show and is not a failure. A payment that DID claim it and is missing a
 *  log is unproven — which is not the same as proven wrong, and must not be
 *  reported as either success or fraud.
 */
export function verdictOf(pullIdx: number | null, payIdx: number | null, jitFunded: boolean): Verdict {
  if (pullIdx === null || payIdx === null) return jitFunded ? "unproven" : "not_jit";
  return pullIdx < payIdx ? "in_order" : "out_of_order";
}

/** Did the vault's recomputed fair price match what the receipt recorded?
 *
 *  `fair = priceWad * units / 1e12`, the one conversion, done here against the
 *  print the receipt itself names. `null` when the print could not be found,
 *  which is an absence rather than a mismatch. */
export function fairMatches(priceWad: bigint | null, units: bigint, fair: bigint): boolean | null {
  if (priceWad === null) return null;
  return (priceWad * units) / 10n ** 12n === fair;
}
