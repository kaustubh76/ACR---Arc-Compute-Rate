import { fmt, money, serviceName } from "./format";
import { INK, stateColor, type OgState } from "./og";

/* The rate as an image anyone can carry: a shields-style badge for a README
 * and a small card for a docs page. Both are plain SVG strings, which is the
 * one format that works as an `<img>` on any site without CORS, a script, or
 * an iframe, and renders in GitHub's image proxy.
 *
 * Pure, so a test can hold the two things that matter: the width is computed
 * from the text so a long unit never clips, and the words on it are the same
 * words the page uses, including the age. A badge that says "live" over a
 * print that is out of use is the failure this project has shipped twice
 * already (see `lib/og.ts`); here the line is an input, judged elsewhere, so
 * this file cannot invent a claim about freshness on its own.
 */

export interface RateSvgInput {
  index: string;
  value: number;
  unit: string;
  state: OgState;
  ageS: number | null;
  /** The freshness line from `freshnessLine`, verbatim. */
  line: string;
  /** The chain's display name, e.g. "Arc". Stamped so an image saved from
   *  the testnet is never mistaken for a mainnet figure. */
  chain: string;
  ciHalfBp?: number;
  costToMove1pct?: number;
  host?: string;
}

const MONO = "IBM Plex Mono, Menlo, Consolas, DejaVu Sans Mono, monospace";
/** A monospace advance. Plex Mono, Menlo and DejaVu Sans Mono all sit at
 *  0.6em, so the width is right in the three faces a reader is likely to
 *  have, and only slightly generous in the rest. */
const ADVANCE = 0.6;

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A compact age for a 20px badge: the long form lives in the title. */
export function shortAge(ageS: number | null): string {
  if (ageS == null) return "?";
  if (ageS < 60) return "<1m";
  const m = Math.round(ageS / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function textWidth(s: string, fontSize: number): number {
  return Math.ceil(s.length * fontSize * ADVANCE);
}

export function badgeSvg(b: RateSvgInput): string {
  const FS = 11;
  const H = 20;
  const PAD = 7;
  const left = b.index;
  const right = `${fmt(b.value)} ${b.unit}`;
  const age = b.state === "sim" ? "sim" : shortAge(b.ageS);
  const lw = textWidth(left, FS) + PAD * 2;
  const rw = textWidth(right, FS) + PAD * 2;
  const aw = textWidth(age, FS) + PAD * 2 + 10;
  const W = lw + rw + aw;
  const title = `${b.index} · ${right} · ${b.line} · ${b.chain}`;
  const dot = stateColor(b.state);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" role="img" aria-label="${esc(title)}" data-chain="${esc(b.chain)}">`,
    `<title>${esc(title)}</title>`,
    `<clipPath id="r"><rect width="${W}" height="${H}" rx="3"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${lw}" height="${H}" fill="${INK.ledger}"/>`,
    `<rect x="${lw}" width="${rw + aw}" height="${H}" fill="${INK.protocol}"/>`,
    `</g>`,
    `<g font-family="${MONO}" font-size="${FS}">`,
    `<text x="${PAD}" y="14" fill="${INK.sky}">${esc(left)}</text>`,
    `<text x="${lw + PAD}" y="14" fill="${INK.sand}">${esc(right)}</text>`,
    `<circle cx="${lw + rw + PAD + 3}" cy="10" r="3" fill="${dot}"/>`,
    `<text x="${lw + rw + PAD + 10}" y="14" fill="${INK.sky}">${esc(age)}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}

export const CARD_SIZE = { width: 320, height: 160 } as const;

export function cardSvg(c: RateSvgInput): string {
  const { width: W, height: H } = CARD_SIZE;
  const eyebrow = `${c.index} · ${serviceName(c.index)}`.toUpperCase();
  const ci = c.ciHalfBp != null && Number.isFinite(c.ciHalfBp) ? ` · ±${c.ciHalfBp.toFixed(1)} bp (95%)` : "";
  const cost =
    c.costToMove1pct != null && Number.isFinite(c.costToMove1pct)
      ? `cost to move 1%: ${money(c.costToMove1pct)}`
      : "";
  const title = `${c.index} · ${fmt(c.value)} ${c.unit} · ${c.line} · ${c.chain}`;
  const dot = stateColor(c.state);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" data-chain="${esc(c.chain)}">`,
    `<title>${esc(title)}</title>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8" fill="${INK.genesis}" stroke="${INK.protocol}"/>`,
    `<g font-family="${MONO}">`,
    `<text x="18" y="28" font-size="10" letter-spacing="1.5" fill="${INK.sky}">${esc(eyebrow)}</text>`,
    `<text x="18" y="80" font-size="40" fill="${INK.sand}">${esc(fmt(c.value))}</text>`,
    `<text x="18" y="100" font-size="11" fill="${INK.sky}">${esc(c.unit + ci)}</text>`,
    cost ? `<text x="18" y="118" font-size="11" fill="${INK.sky}">${esc(cost)}</text>` : "",
    `<circle cx="21" cy="139" r="3" fill="${dot}"/>`,
    `<text x="30" y="143" font-size="10" fill="${INK.sky}">${esc(c.line)}</text>`,
    c.host ? `<text x="${W - 18}" y="${H - 8}" font-size="9" text-anchor="end" fill="${INK.mute}">${esc(c.host)}</text>` : "",
    `</g>`,
    `</svg>`,
  ].join("");
}
