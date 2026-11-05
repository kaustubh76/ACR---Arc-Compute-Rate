/* The World gate's approval queue, as the press serves it.

   One payment parked for a verified human: what it is, what the chain thinks
   it is worth, the code the human types into World App, and what they did
   about it. The press's public view carries no secret — never the device code,
   which is the bearer of the whole approval, and never the identity token.

   `expires_in_s` and not a timestamp, deliberately. The vault's deadline is a
   `block.timestamp`, and a browser subtracting its own wall clock from one
   would be wrong by however far the two epochs sit apart. A duration is the
   same length in both clocks. */

/** The outcome words the press uses. "claimed" is the instant between a
 *  validated proof and the chain's answer, and a reader may see it. */
export type FloatStatus = "open" | "claimed" | "consumed" | "denied" | "expired" | "failed";

export type FloatCheckpoint = {
  id: number;
  kind: "spend" | "policy";
  status: FloatStatus;
  /** Why it was parked, or why it ended. The chain's own sentence. */
  reason: string;
  agent: string;
  seller: string;
  index: string;
  units: number;
  /** Decimal USDC, as every `_usdc` field here is. */
  quote_usdc: number;
  fair_usdc: number;
  /** Blank once the checkpoint is finished: a spent code invites a retry. */
  user_code: string;
  verify_uri: string;
  expires_at: number;
  expires_in_s: number;
  tx: string | null;
};

export type FloatQueue = {
  /** "ok" when this host runs the gate, "pending" when it does not. NOT the
   *  status of any checkpoint — those have their own, and conflating the two
   *  let a parked payment read as a healthy envelope. */
  status: "ok" | "pending";
  /** Present when `status` is "pending": what the gate is missing. */
  reason?: string;
  checkpoints: FloatCheckpoint[];
};

/** How far over the chain's fair price this quote sits, as a percentage.
 *
 *  A percentage and not basis points: the vault's policy is in bp and a human
 *  reads percent, and carrying both in one row is a mistake this terminal has
 *  already made once on the curve. `null` when there is no fair price to
 *  compare against, which renders as an ellipsis rather than as zero.
 */
export function premiumPct(c: Pick<FloatCheckpoint, "quote_usdc" | "fair_usdc">): number | null {
  if (!Number.isFinite(c.fair_usdc) || c.fair_usdc <= 0) return null;
  if (!Number.isFinite(c.quote_usdc)) return null;
  return ((c.quote_usdc - c.fair_usdc) / c.fair_usdc) * 100;
}

/** The chip colour for an outcome, from the five tiers the stylesheet has. */
export function statusChip(s: FloatStatus): string {
  if (s === "consumed") return "chip-teal";
  if (s === "open" || s === "claimed") return "chip-sky";
  if (s === "denied" || s === "failed") return "chip-breach";
  return "chip-sim";
}

/** mm:ss, floored at zero. Seconds only above an hour would read as a bug. */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
