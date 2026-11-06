/* The vault's spend ladder, as arithmetic and order a test can pin.
 *
 * `FloatVault._check` is an ordered ladder of twelve named refusals. Every rung
 * returns its own English sentence, and `classify` exposes the same ladder as a
 * free `view` — "so a caller can ask 'would this be refused, and why' without a
 * transaction and get the chain's real answer" (FloatVault.sol:660).
 *
 * WHAT IS IN THIS FILE AND WHAT IS NOT. The codes, their order, and the
 * thresholds a reader can see for themselves. No reason strings and no reader
 * copy: the chain supplies the sentence, and the gloss beside each rung is a
 * literal `<Ed x= p=>` in the component, because the coverage gates match
 * literal props and copy hoisted into a table here would render identically
 * while escaping the plain-copy limit and the banned-term list. Same split
 * `lib/loop.ts` states: this file is arithmetic.
 *
 * NOTHING HERE PREDICTS AN OUTCOME. `bandCeiling` and `headroom` are the
 * thresholds themselves, not a guess at which rung will bite — that answer only
 * ever comes from the chain. A local re-implementation of the ladder would be a
 * second source of truth that disagrees under rounding, and the one number a
 * reader must be able to trust here is the one the vault itself returned.
 */

/** The twelve rungs, in the order `_check` runs them.
 *
 *  `code` is the `uint8` the contract returns and `name` is the public constant
 *  that holds it, so a reader can find the rung in the source. Both are read
 *  off FloatVault.sol:96-107; `lib/floatLadder.test.ts` pins the pair.
 */
export const LADDER = [
  { code: 1, name: "D_PAUSED" },
  { code: 2, name: "D_UNKNOWN_AGENT" },
  { code: 3, name: "D_FROZEN" },
  { code: 4, name: "D_SELLER" },
  { code: 5, name: "D_REPLAY" },
  { code: 6, name: "D_UNITS" },
  { code: 7, name: "D_NO_PRINT" },
  { code: 8, name: "D_STALE" },
  { code: 9, name: "D_ROTATED" },
  { code: 10, name: "D_BAND" },
  { code: 11, name: "D_PER_REQUEST" },
  { code: 12, name: "D_DAILY_CAP" },
] as const;

export type LadderRung = (typeof LADDER)[number];
/** 0 is "allowed", 1..12 name the rung that stopped it. */
export type DenialCode = 0 | LadderRung["code"];

/** The one code that is not a refusal.
 *
 *  FloatVault.sol:752, on why this rung alone does not burn the nonce: "that
 *  refusal is not a refusal — it is an escalation, and the same request has to
 *  survive to be parked and then executed by `executeApproved`." Everything
 *  else means the request is finished and must be re-quoted.
 */
export const ESCALATION_CODE = 11;

/** A code off the wire, or null. Null rather than a default: an unparseable
 *  answer must not render as "allowed", which is the one reading that would put
 *  a payment on screen that the chain never approved. */
export function parseDenialCode(raw: unknown): DenialCode | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 12) return null;
  return n as DenialCode;
}

/** Whether this code parks the request for a human rather than finishing it. */
export function escalates(code: DenialCode | null): boolean {
  return code === ESCALATION_CODE;
}

/** The CSS state for one rung, given the code the chain returned.
 *
 *  The four values map one-to-one onto states `globals.css` already ships for
 *  `.flow-node`, so a ladder needs no new rule: `passed` is teal, `blocked` is
 *  the breach wash, `lit` is gold and pulses, `dim` is dashed at half opacity.
 *
 *  The escalation rung is `lit`, not `blocked`, and that distinction is the
 *  product: a parked request is alive and waiting on a person, not refused.
 *  Painting it red would say the opposite of what the vault did.
 *
 *  `null` dims the whole ladder rather than inventing a verdict.
 */
export function rungState(rung: LadderRung, code: DenialCode | null): "passed" | "blocked" | "lit" | "dim" {
  if (code === null) return "dim";
  if (code === 0) return "passed";
  if (rung.code < code) return "passed";
  if (rung.code > code) return "dim";
  return code === ESCALATION_CODE ? "lit" : "blocked";
}

/** The largest quote the band admits, in decimal USDC.
 *
 *  The contract's test is `quoteTotal > fair * (10_000 + band) / 10_000` on
 *  6-decimal integer units, so this is that bound carried into the decimal view
 *  a reader sees. A THRESHOLD, not a verdict: showing where a quote sits
 *  relative to it is a fact, and which rung bites is still the chain's to say.
 *
 *  `null` when there is no fair price to band against, which renders as an
 *  ellipsis rather than as zero — the same choice `premiumPct` makes.
 */
/** The six ways a rung can paint.
 *
 *  FOUR OF THESE ARE THE CHAIN'S ANSWER AND TWO ARE THE WALK'S. `passed`,
 *  `blocked`, `lit` and `dim` come from `rungState` and describe what the vault
 *  said. `running` and `queued` describe only how far this surface has got
 *  through drawing it, and they exist because the ladder used to draw three
 *  different facts identically:
 *
 *    - "the vault has not answered yet"
 *    - "the ladder never reached this rung"
 *    - "the light has not arrived here yet"
 *
 *  All three were `dim`, a dashed box, so the first paint of the page was twelve
 *  dashed boxes that looked like a rendering fault. They are different facts and
 *  they now paint differently. */
export type RungPaint = "passed" | "blocked" | "lit" | "dim" | "queued" | "running";

/** What a rung paints when the light has reached `walk`.
 *
 *  THE LIGHT ALWAYS TRAVELS ALL TWELVE, even when rung three answered. The tail
 *  past the deciding rung has to settle to `dim` — "not reached" — and if the
 *  walk stopped at the answer those rungs would sit in `queued` for ever,
 *  claiming the light was still coming. So the walk runs to the end and the
 *  rungs behind the stop fade in as unreached, which is also what the sequence
 *  actually looks like: it runs, it hits the rung, the rest never happened. */
export function walkedState(rung: LadderRung, code: DenialCode | null, walk: number): RungPaint {
  if (code === null) return "running";
  if (rung.code > walk) return "queued";
  return rungState(rung, code);
}

/** The rung that answered, or null when nothing stopped it (or nothing asked).
 *
 *  Null for BOTH "cleared all twelve" and "no answer yet", because neither has
 *  a deciding rung — the surface tells those two apart by the code itself, and
 *  a number here would have to invent one. */
export function stoppedAt(code: DenialCode | null): number | null {
  return code === null || code === 0 ? null : code;
}

/** How many rungs the vault got through: twelve when it cleared, otherwise the
 *  rungs BEFORE the one that stopped it. Used for the track and the headline, so
 *  a reader can see how far it got without counting boxes. */
export function clearedCount(code: DenialCode | null): number {
  if (code === null) return 0;
  return code === 0 ? LADDER.length : code - 1;
}

/** A mark for each paint.
 *
 *  SYMBOLS LIVE HERE AND WORDS DO NOT, which is the same split the file header
 *  states for reason strings: a glyph is a deterministic mapping a test can pin,
 *  while reader copy hoisted out of the component would escape the plain-copy
 *  limit and the banned-term list. The component pairs each of these with an
 *  `<Ed>` naming the state in words, because a mark on its own is colour by
 *  another route and fails SC 1.4.1 just the same. */
export function rungSymbol(paint: RungPaint): string {
  if (paint === "passed") return "\u2713";
  if (paint === "blocked") return "\u2715";
  if (paint === "lit") return "\u21AF";
  return "\u00B7";
}

export function bandCeiling(fairUsdc: number, bandBps: number): number | null {
  if (!Number.isFinite(fairUsdc) || fairUsdc <= 0) return null;
  if (!Number.isFinite(bandBps) || bandBps < 0) return null;
  return (fairUsdc * (10_000 + bandBps)) / 10_000;
}

/** What is left of a cap once today's spend is taken off it.
 *
 *  Floored at zero: a cap already exceeded has no negative headroom, and a
 *  minus sign here would read as a credit.
 */
export function headroom(capUsdc: number, spentUsdc: number): number | null {
  if (!Number.isFinite(capUsdc) || capUsdc < 0) return null;
  if (!Number.isFinite(spentUsdc) || spentUsdc < 0) return null;
  return Math.max(0, capUsdc - spentUsdc);
}

/** Whether a quote reaches the agent's own per-request authority.
 *
 *  THE BOUNDARY IS INCLUSIVE AND THAT IS LOAD-BEARING. FloatVault.sol:740
 *  refuses on `quoteTotal >= a.perRequestUsdc`, with the comment "strictly below
 *  is the agent's own authority — the convention `PolicyWallet.spend` documents,
 *  kept identical here on purpose." A quote exactly at the threshold escalates;
 *  off-by-one here would put the demo's headline number on the wrong side.
 */
export function atOrOverThreshold(quoteUsdc: number, thresholdUsdc: number): boolean {
  if (!Number.isFinite(quoteUsdc) || !Number.isFinite(thresholdUsdc) || thresholdUsdc <= 0) return false;
  return quoteUsdc >= thresholdUsdc;
}
