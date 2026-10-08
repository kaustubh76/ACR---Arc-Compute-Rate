import { isUnit } from "./indices";
import type { SpendDecision } from "./types";

/* Lifted out of `app/spend/view.tsx` so it can be TESTED. The rules it
   encodes are not obvious from the call site -- which unit counts, which of
   two quantities, and that a partial URL is worse than none -- and a rule
   nobody can test is a rule that drifts. `lib/tape.ts` holds the tape's pure
   helpers for the same reason. */

/** A `/check` URL for this bill, or null when one would not work.
 *
 *  Three fields have to be present AND the unit has to be one of the three the
 *  press can price: `/check` validates the whole query on mount and populates
 *  nothing from a partial one, so an almost-complete link lands a reader on an
 *  empty form having promised them a verdict.
 *
 *  `vendor_quantity` rather than `metered_quantity`: this prices WHAT WAS
 *  BILLED, which is the number the owner is being asked to agree with. The
 *  meter is the separate question of whether that quantity was real, and the
 *  discrepancy line above already answers it.
 */
export function checkHref(d: SpendDecision): string | null {
  const unit = (d.unit ?? "").trim();
  const qty = d.vendor_quantity;
  if (!isUnit(unit) || !d.billed_usdc || d.billed_usdc <= 0) return null;
  if (qty == null || !Number.isFinite(qty) || qty <= 0) return null;
  const q = new URLSearchParams({
    unit,
    billed_usdc: String(d.billed_usdc),
    quantity: String(qty),
  });
  // The vendor changes the ANSWER rather than the labelling — the press
  // benchmarks one of our own sellers against the fleet and a stranger against
  // the market — so it is carried when we have it.
  if (d.vendor) q.set("vendor", d.vendor);
  return `/check?${q.toString()}`;
}
