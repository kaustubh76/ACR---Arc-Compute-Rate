import { ageWords } from "./format";
import { printFreshness, type PrintFreshness } from "./printAge";

/* What a shared link, a badge and a card say about the number they carry.
 *
 * Three surfaces now put the print somewhere the page's own chrome is not:
 * the preview image a pasted link unfurls with, an SVG badge in somebody's
 * README, a card in their docs. None of them can rely on the dateline above
 * the hero to say how old the figure is, so each carries the age itself, in
 * the same words, judged by the same clock (`printAge.ts`, which reads the
 * press's own `ops.py` thresholds). An overdue print must never be captioned
 * "live": twice this project has shipped a stale number under that word, and
 * a card in a stranger's README is the one place nobody would ever correct it.
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;

/** The OpenGraph base `app/layout.tsx` sets. A page that overrides
 *  `openGraph` (to add its own image) must spread this back in, because Next
 *  replaces a parent's `openGraph` object wholesale rather than merging it. */
export const OG_BASE = {
  type: "website",
  siteName: "ACR · The Arc Compute Rate",
  locale: "en_US",
} as const;

/** Arc Dawn, by hand: the tokens in globals.css are CSS variables, and neither
 *  an SVG string nor `ImageResponse` can read them. Same hex, same names. */
export const INK = {
  genesis: "#000b24",
  ledger: "#0b223e",
  protocol: "#1b3158",
  sky: "#acc6e9",
  sand: "#ffcc6f",
  gold: "#e9a13f",
  teal: "#4fb3a9",
  mute: "#6b7a90",
} as const;

export type OgState = PrintFreshness | "sim";

/** The line under the number, and the state it was judged to be in. */
export function freshnessLine(
  postedAt: number | null | undefined,
  nowS: number,
  onchain: boolean,
): { text: string; state: OgState } {
  if (!onchain) return { text: "sim estimate · nothing posted on chain yet", state: "sim" };
  const { state, ageS } = printFreshness(postedAt, nowS);
  const age = ageS == null ? null : ageWords(ageS);
  switch (state) {
    case "fresh":
      return { text: `posted ${age} · live on chain`, state };
    case "late":
      return { text: `posted ${age} · late`, state };
    case "overdue":
      return { text: `posted ${age} · past the settle window`, state };
    default:
      return { text: "archived print · age unknown", state };
  }
}

/** The dot beside the line: teal while current, gold once late, grey once it
 *  is out of use or cannot be judged. Mirrors the chips on the page. */
export function stateColor(state: OgState): string {
  if (state === "fresh") return INK.teal;
  if (state === "late") return INK.gold;
  return INK.mute;
}
