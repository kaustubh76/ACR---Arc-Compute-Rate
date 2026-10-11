import { serviceName } from "./format";

/* The three lines a reader pastes to carry the rate: a Markdown badge for a
 * README, an HTML card for a page, and the curl that reads the print the
 * image was drawn from. Pure and origin-parameterised, so no file in this
 * tree hardcodes a host that `tests/test_canonical_host.py` would then have
 * to know about; the component passes `window.location.origin`, which is by
 * definition the deployment the reader is looking at.
 */

export const EMBED_KINDS = ["badge", "card", "curl"] as const;
export type EmbedKind = (typeof EMBED_KINDS)[number];

export interface EmbedSnippets {
  badge: string;
  card: string;
  curl: string;
}

function trim(u: string): string {
  return u.replace(/\/+$/, "");
}

export function badgeUrl(origin: string, index: string): string {
  return `${trim(origin)}/api/badge/${index}.svg`;
}

export function cardUrl(origin: string, index: string): string {
  return `${trim(origin)}/api/card/${index}.svg`;
}

/** The image an open embed row previews, or null for a snippet that has none. */
export function previewUrl(origin: string, index: string, kind: EmbedKind): string | null {
  if (kind === "badge") return badgeUrl(origin, index);
  if (kind === "card") return cardUrl(origin, index);
  return null;
}

export function embedSnippets(origin: string, index: string, seller: string): EmbedSnippets {
  const o = trim(origin);
  const alt = `${index}, the Arc Compute Rate for ${serviceName(index).toLowerCase()}`;
  return {
    badge: `[![${alt}](${badgeUrl(o, index)})](${o}/index/${index})`,
    card:
      `<a href="${o}/index/${index}">` +
      `<img src="${cardUrl(o, index)}" width="320" height="160" alt="${alt}">` +
      `</a>`,
    // The print itself, from the press the terminal reads: an image is a
    // picture of this answer, and the answer is one GET away.
    curl: `curl -s ${trim(seller)}/onchain/${index}`,
  };
}
