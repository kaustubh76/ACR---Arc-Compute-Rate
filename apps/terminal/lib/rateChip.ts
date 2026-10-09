/* The verdict chip for a priced bill.
 *
 * IN lib/ SO A TEST CAN REACH IT. `npm test` runs `lib/*.test.ts` only, which
 * is the same argument `lib/readResult.ts` and `lib/sellerLadder.ts` already
 * make: a decision living inside a view is a decision no gate can hold. This
 * one decides whether a real invoice gets a confident verdict, and it has a
 * date on it (see below), so it needs one.
 */

/** The verdict chip. Four states, keyed on the RATE rather than on
 *  `verdict.verdict`, which answers a different question.
 *
 *  THE FOURTH STATE IS WHOSE PRICES ANSWERED, and leaving it out was the most
 *  dangerous thing on this page. `/par` falls back to the FLEET's own quotes
 *  whenever the market basket is unusable or stale, so "we compared you to the
 *  market" and "we compared you to ourselves" were the same screen with one
 *  field different — and that field was two sections below this chip, under
 *  the fold of the answer. `anchors/GAP.md` records the fleet scale at 20x to
 *  1250x off real prices, which makes a confident "over the rate" on a real
 *  invoice indefensible the moment a reviewer opens that file.
 *
 *  IT IS DATED, NOT HYPOTHETICAL. The baskets are 2026-10-06 and
 *  `ANCHOR_MAX_AGE_S` is thirty days, and `scripts/anchors.py --fetch` is
 *  manual and in no CI — so around 2026-11-05 every answer flips to the fleet
 *  on its own. The chip has to carry the caveat, because by then nobody will
 *  be watching for it. */
export function rateChip(
  bpOver: number | null,
  against?: string,
  basket?: string,
): { cls: string; x: string; p: string } {
  if (bpOver == null) return { cls: "chip muted", x: "no benchmark", p: "nothing to compare" };
  // Not the market: say so IN the verdict, not below it. Muted on purpose —
  // a comparison against our own quotes must not wear the same confident
  // colour as one against prices somebody else published.
  if (against && against !== "market") {
    const why = basket === "STALE" ? "our prices, basket stale" : "our prices, not the market";
    return { cls: "chip muted", x: why, p: "compared to our own prices" };
  }
  if (bpOver > 25) return { cls: "chip chip-breach", x: "over the rate", p: "more than others charge" };
  if (bpOver < -25) return { cls: "chip chip-teal", x: "under the rate", p: "less than others charge" };
  return { cls: "chip chip-gold", x: "at the rate", p: "about what others charge" };
}
