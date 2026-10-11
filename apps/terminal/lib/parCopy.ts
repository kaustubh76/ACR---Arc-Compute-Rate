/* WHY there is no benchmark, when there is none: the words.
 *
 * `par.reason` mirrors the subgraph's `unbenchmarkedReason` on the principle
 * that an absent benchmark says WHICH absence it is. The page renders these
 * sentences and so does the preview image a shared link unfurls with; they
 * live here so the two can never say different things about the same bill.
 */

export const NO_BENCHMARK_WHY: Record<string, { x: string; p: string }> = {
  NO_QUOTES: {
    x: "No published price was found for this unit at all, so there is nothing to compare against.",
    p: "We found no prices for this kind of work, so we cannot say.",
  },
  ONE_SELLER: {
    x: "Only one price was found. One offer is not a market, and comparing a price to itself would be a number pretending to be a measurement.",
    p: "We only found one price. One price is not a market, so we will not pretend.",
  },
  NO_INDEPENDENT_SELLER: {
    x: "Every price found belongs to a seller this deployment operates, so a comparison would be us grading ourselves.",
    p: "All the prices we found are our own, so this check would mean nothing.",
  },
  NO_QUANTITY: {
    x: "Without a quantity there is no per-unit price, and a whole bill cannot be compared with a rate.",
    p: "We need to know how much you bought before we can compare.",
  },
};

/** The expert sentence for a reason code, with the same fallback the page uses
 *  for a code it has never seen: the engine's own word, never a blank. */
export function noBenchmarkLine(reason: string): string {
  return (
    NO_BENCHMARK_WHY[reason]?.x ??
    `No benchmark is available for this bill. The engine's reason: ${reason || "unstated"}.`
  );
}

/** Six significant figures, not a fixed width: these numbers run from
 *  0.000002 to 4.00, and a fixed two decimals renders most of them as 0.00.
 *  The same mistake once gave ACR-DATA's mid and ask two significant figures
 *  and printed them identically. */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "…";
  if (n === 0) return "0";
  return n.toPrecision(6).replace(/\.?0+$/, "");
}

export function fmtBp(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "…";
  return `${n >= 0 ? "+" : ""}${n.toFixed(0)} bp`;
}
