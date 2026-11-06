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

/** The venue's own exit, which happens BEFORE our sleeve records anything.
 *
 *  MATCHED ON THE EVENT AND THE ADDRESS TOGETHER, and both halves are load
 *  bearing. The venue emits FOUR logs in a just-in-time payment and only one is
 *  its ERC-4626 exit: on the canonical receipt they sit at 16, 25, 26 and 29,
 *  so "the first log from the venue" picks 16 and would draw Morpho acting
 *  before the price was even read. And the event alone is not enough either,
 *  because an ERC-4626 `Withdraw` from any other address in the same receipt
 *  would decode identically now that VENUE_ABI carries the event.
 *
 *  The LAST one before the payment, for the reason `pickPull` gives: a
 *  rebalance and a just-in-time pull can both appear in one transaction, and
 *  the one that funded this payment is the one immediately before it. */
export function pickVenueWithdraw(
  logs: readonly WalkLog[],
  venue: string | undefined,
  payIdx: number | null,
): WalkLog | null {
  if (!venue) return null;
  const outs = logs.filter((l) => same(l.addr, venue) && l.name === "Withdraw");
  const before = payIdx === null ? outs : outs.filter((l) => l.idx < payIdx);
  return before.length ? before[before.length - 1] : (outs[0] ?? null);
}

/** The shares the venue burned to release those assets.
 *
 *  An ordinary ERC-20 `Transfer` to the zero address, FROM the sleeve, on the
 *  venue's own token. ERC20_ABI already decodes it, so the only thing that
 *  tells it apart from the USDC transfers in the same receipt is the address it
 *  was emitted by. Returned separately from the withdraw because the two are
 *  different facts and either can be absent. */
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export function pickShareBurn(logs: readonly WalkLog[], venue: string | undefined): WalkLog | null {
  if (!venue) return null;
  const burns = logs.filter(
    (l) => same(l.addr, venue) && l.name === "Transfer" && same(String(l.args.to), ZERO_ADDR),
  );
  return burns.length ? burns[burns.length - 1] : null;
}

/** How many logs the venue emitted in this transaction, named or not.
 *
 *  COUNTED AND NOT CAPTIONED. Two of the four on the canonical receipt are the
 *  venue's internal bookkeeping and this repo has no business asserting what
 *  they are. Saying "four logs, two of which we can name" is honest; inventing
 *  labels for the other two would not be.
 *
 *  TAKES THE RAW LOGS, NOT THE DECODED ONES, and that is the whole point of the
 *  function. `readWalk` only keeps a log if it decodes against one of the ABIs
 *  it holds, and the two unidentified venue logs match none of them — so
 *  counting `WalkLog`s would report two and call it four's worth of evidence.
 *  The count is of what the chain emitted, which is the receipt. */
export function countVenueLogs(
  raw: readonly { address: string }[],
  venue: string | undefined,
): number {
  return venue ? raw.filter((l) => same(l.address, venue)).length : 0;
}
