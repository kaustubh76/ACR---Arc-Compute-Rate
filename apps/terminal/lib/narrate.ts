/* What a model may and may not say on this surface.
 *
 * WHY THIS FILE EXISTS. Every figure the terminal prints is computed and
 * provable, and `lib/coverage.test.ts` enforces the register and the jargon
 * ban by reading STATIC `p="…"` props out of the source. A sentence that
 * arrives at runtime from a model bypasses both gates completely: there is no
 * source for the linter to read. So the same rules are applied here, to the
 * answer, before it is allowed near a reader.
 *
 * THREE REFUSALS, AND THE FIRST IS THE ONE THAT MATTERS. A digit means the
 * model produced a figure nobody computed, on a page whose entire claim is that
 * it has none. That is not softened or stripped; the whole answer is dropped,
 * because a sentence with its numbers cut out is a sentence that no longer says
 * what it was checked for.
 *
 * The jargon list is a copy of the gate's, and `narrate.test.ts` holds the two
 * together by reading the gate's own regex, so the plain edition's vocabulary
 * and the model's cannot drift apart silently. */

/** The terms the Plain Edition bans. Mirrors `BANNED_IN_PLAIN` in
 *  `lib/coverage.test.ts`; the test in this file's sibling proves it. */
export const BANNED_WORDS = [
  "VWAP",
  "EIP-712",
  "EIP712",
  "EIP-3009",
  "EIP3009",
  "x402",
  "sybil",
  "hedonic",
  "deconvolv",
  "attestation",
  "provenance",
  "settlement-grade",
  "SLO",
  "Louvain",
  "Kalman",
  "CAIP",
  "standfirst",
  "colophon",
  "Malachite",
  "BFT",
  "nanopayment",
  "ACROracle",
  "estimand",
  "tenor",
] as const;

/** A sentence with a figure in it is not the sentence that was asked for. */
export function hasFigure(s: string): boolean {
  return /\d/.test(s);
}

/** Which banned terms a model's answer reached for, if any. */
export function jargonIn(s: string): string[] {
  const low = s.toLowerCase();
  return BANNED_WORDS.filter((w) => low.includes(w.toLowerCase()));
}

/** The em dash the house separator replaced. Four jobs, one mark, so none. */
export function hasEmDash(s: string): boolean {
  return s.includes("—");
}

export type Printable = { ok: true; text: string } | { ok: false; why: string };

/** Is this answer fit to put on the page?
 *
 *  Order matters only in what the reader is told; any failure drops the whole
 *  answer. `trim()` first, because a model that answered with whitespace
 *  answered with nothing. */
export function printable(raw: string | undefined | null): Printable {
  const text = (raw ?? "").trim();
  if (text.length === 0) return { ok: false, why: "the narrator returned nothing" };
  if (hasFigure(text)) return { ok: false, why: "the narrator put a figure in prose, and figures come off the chain" };
  if (hasEmDash(text)) return { ok: false, why: "the narrator used an em dash, which this house does not print" };
  const jargon = jargonIn(text);
  if (jargon.length > 0) return { ok: false, why: `the narrator used jargon the plain edition bans: ${jargon.join(", ")}` };
  return { ok: true, text };
}
