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

/* --- the vault's own state, as this server reads it off the chain ---------

   Types only, same rule as the guest block above: every string a reader sees is
   a literal `<Ed x= p=>` in the view.

   ONE SHAPE FOR "CONFIGURED" AND "STOOD DOWN", matching `GuestContext` rather
   than inventing a second idiom. A float vault exists on one chain, so a host
   asked about any other chain has to say that rather than answer with zeros —
   and zero buffer, zero sleeves and zero receipts is a perfectly readable
   screen that happens to describe a treasury that does not exist. `status` is
   the envelope's axis, never a checkpoint's. */

/** One yield sleeve. `null` where a sleeve is not active: the reserve ships as
 *  a null sleeve pending an allowlist, and `ACR_Float.md` is emphatic that this
 *  is shown as a banner and never as a mock. */
export type FloatSleeve = {
  address: string;
  value_usdc: number;
};

/** What the vault knows about one agent. `exists` is the whole answer to
 *  "is this agent enrolled" — every other field is meaningless without it. */
export type FloatAgentStanding = {
  /** The preimage, as `policy.config.json` names it. The chain stores the hash. */
  name: string;
  agent_id: string;
  exists: boolean;
  daily_cap_usdc: number;
  spent_usdc: number;
  remaining_usdc: number;
  /** At or above this the request escalates; strictly below is the agent's own
   *  authority. The boundary is inclusive, as `FloatVault._check` has it. */
  per_request_usdc: number;
  frozen: boolean;
  guest: boolean;
};

/** The policy in force, in the units the contract stores it in.
 *
 *  Basis points stay basis points here and become a percentage at the edge: the
 *  vault's policy is written in bp and a reader reads percent, and carrying
 *  both in one row is a mistake this terminal has already made once. */
export type FloatPolicyView = {
  max_premium_bps: number;
  /** Always at or above `max_premium_bps`: an approval widens the band, never
   *  narrows it, and `setPolicy` refuses the other way round. */
  human_max_premium_bps: number;
  max_print_age_s: number;
  working_share_bps: number;
  buffer_hours: number;
  min_ticket_usdc: number;
};

/** One index the print store carries, with its newest print.
 *
 *  `print_id` of 0 means NO PRINT, not a print numbered zero: ids start at 1.
 *  A paused store also reads as all zeroes, so both route through the same
 *  "no print for index" path rather than rendering as a zero price. */
export type FloatPrint = {
  index: string;
  /** The preimage the store names itself, so no model literal lives here. */
  name: string;
  price_usd_per_1k: number;
  /** The SAME price as the chain stores it, 18 decimals, as a decimal string.
   *
   *  Runway divides this, not `price_usd_per_1k`. Both implementations that
   *  already compute runway — `float/app/index.html` and the `float_runway`
   *  MCP tool — divide the integer, and a float carrying the same quantity
   *  drifts against them. A string because JSON has no bigint. */
  price_wad: string;
  ci_bps: number;
  print_id: number;
  age_s: number;
  stale: boolean;
};

export type FloatVaultState = {
  /** "ok" when this chain has a float vault configured, "pending" when it does
   *  not. NOT the status of anything on the chain. */
  status: "ok" | "pending";
  /** Present when "pending": which chain, or which piece of configuration. */
  reason?: string;
  vault?: string;
  /** The seller this deployment allowlists, so a reader can aim a dry run at a
   *  seller the vault accepts and at one it does not. */
  seller?: string;
  paused?: boolean;
  /** What is left in the vault itself for the next payment. */
  buffer_usdc?: number;
  working?: FloatSleeve | null;
  reserve?: FloatSleeve | null;
  /** Buffer plus both sleeves: the treasury's own free float. */
  total_usdc?: number;
  receipts?: number;
  /** The fixed template every guest budget is issued against. Read from the
   *  vault rather than inferred from an enrolled agent: on a chain where nobody
   *  has joined yet there is no guest to read it off, and the door that offers
   *  one still has to say what it offers. */
  guest_daily_cap_usdc?: number;
  policy?: FloatPolicyView;
  agents?: FloatAgentStanding[];
  prints?: FloatPrint[];
  /** True when the chain asked us to slow down and some field could not be
   *  read. The fields it covers are ABSENT rather than zero, and a sleeve is
   *  `undefined` here where an inactive one is `null`: "we could not read this"
   *  and "this is not live" are opposite facts and only one of them is news
   *  about the treasury. Measured against the live vault, nine of eleven reads
   *  came back throttled and rendered as a treasury with nothing in it. */
  partial?: boolean;
};

/** The chain's answer to "would this be refused, and why".
 *
 *  `code` 0 is allowed and 1..12 names the rung that stopped it. `reason` is the
 *  vault's own sentence, passed through unreworded, because a branch on it is a
 *  branch on fact. `fair_usdc` comes back even on the refusals that computed it,
 *  which is what lets a refusal carry the fair counter-price. */
export type FloatVerdict = {
  status: "ok" | "pending";
  reason?: string;
  code?: number;
  chain_reason?: string;
  fair_usdc?: number;
  print_id?: number;
  /** The quote that was classified, echoed so a slow answer cannot be read
   *  against a slider that has since moved. */
  quote_usdc?: number;
};

/* --- the tape: every payment and every refusal the chain kept -------------

   TWO EVENTS, ONE LIST. `Receipt` and `Denied` are the whole public record of
   what this treasury did, and they belong beside each other: a page showing
   only payments would describe a treasury that has never refused anything,
   which is the opposite of the claim. */

export type FloatTapeRow = {
  kind: "paid" | "refused";
  block: number;
  tx: string;
  agent_id: string;
  index: string;
  quote_usdc: number;
  /** What the chain recomputed the price as. Carried on refusals too, which is
   *  what lets one say "here is what this should have cost". */
  fair_usdc: number;
  /** SIGNED. A quote below fair is legal, so this goes negative and must not be
   *  read as an enormous overcharge. `null` when there was no fair price. */
  premium_bps: number | null;
  /** paid only */
  id?: number;
  units?: number;
  /** The shortfall came out of the yield venue in this same transaction. */
  jit_funded?: boolean;
  guest?: boolean;
  human_approved?: boolean;
  /** refused only: the rung, and the chain's own sentence. */
  code?: number;
  reason?: string;
};

export type FloatTape = {
  status: "ok" | "pending";
  reason?: string;
  rows: FloatTapeRow[];
  /** THE WINDOW, NOT THE HISTORY. Arc caps a log query at roughly ten thousand
   *  blocks, so this is the most recent slice and the surface has to say so
   *  rather than let a reader take an empty tape for an idle treasury. */
  from_block?: number;
  to_block?: number;
  window_blocks?: number;
  partial?: boolean;
};
