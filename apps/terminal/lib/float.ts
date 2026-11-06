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

/* --- the guest join, as the press and the Developer Portal serve it -------

   Types only, and deliberately no reader-facing copy. Every string a visitor
   sees is a literal `<Ed x= p=>` in the view, because the coverage gates match
   on literal props: copy hoisted into a helper here would render identically
   and silently escape the 140-character plain limit, the banned-term list and
   the em-dash check. A gate that a refactor can step around is not a gate. */

/** The press's named refusals. This tuple IS the contract the join page is
 *  written against — `floatguest.REASONS` is the same list, and a test walks
 *  every one of them through the route. */
export type GuestReason =
  | "wrong_environment"
  | "unknown_or_expired_request"
  | "verify_failed"
  | "no_nullifier"
  | "below_sybil_floor"
  | "one_guest_budget_per_human"
  | "not_a_guest_agent"
  | "the_till_is_empty";

/** What the widget needs, minted server-side.
 *
 *  `rp_context` is snake_case and its signature field is `signature`, while
 *  the signer returns `{sig, createdAt, expiresAt}` in camelCase. The rename
 *  happens once, in the context route, and is pinned by a test: a widget
 *  handed `sig` renders and then fails at World, which is the worst kind of
 *  broken because it looks like it works.
 */
export type GuestRpContext = {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
};

export type GuestContext = {
  /** "ok" when this host can mint a request, "pending" when it cannot. */
  status: "ok" | "pending";
  /** Present when "pending": which piece of configuration is missing. */
  reason?: string;
  app_id?: string;
  action?: string;
  rp_context?: GuestRpContext;
};

/** What the chain did, with the nullifier already gone.
 *
 *  `human` is a mask the press applies before the value leaves it, and
 *  `agent_id` is the hash the chain stores. Neither can be walked back to the
 *  nullifier, which is the whole reason the id is a hash of it. */
export type GuestBudget = {
  ok: boolean;
  agent: string;
  agent_id: string;
  daily_cap_usdc: number;
  tx: string;
  human: string;
  sandbox_observed: boolean | null;
};

export type GuestClaim = {
  status: "ok" | "pending";
  reason?: string;
  claim?: GuestBudget;
};

/** An address we are willing to attach a budget to.
 *
 *  Checksum is NOT required: a visitor pasting from a block explorer gets
 *  mixed case and a visitor typing gets lower, and refusing the second would
 *  be refusing the commoner case. Length and charset are the whole check,
 *  because the only thing a wrong address costs here is a budget nobody can
 *  spend. */
export function isAgentAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}
