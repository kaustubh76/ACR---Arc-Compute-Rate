import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* The front page's print must fit its column.
 *
 * Measured on the live site on 2026-10-11, over CDP at four viewports: at 1280
 * the seven digit boxes of "0.49533" took 664px of a 679px column and fit by a
 * hair; at 1440, 1536 and 1920 the rule's `13vw` had hit its 184px cap, seven
 * glyphs of IBM Plex Mono needed 735px, and the headline number wrapped to
 * "0.4953" with a lone "3" on the line below. Every laptop wider than about
 * 1300px saw the one figure the whole page exists to show, broken.
 *
 * The cause was a unit: a viewport unit sizes the print to the WINDOW, while
 * the column it sits in is capped at 62ch of body copy. The two scale apart.
 * Container-query units size the print to the column, and `nowrap` makes the
 * remaining failure visible (overflow) rather than silent (a second line).
 *
 * Plex Mono's advance is 0.6em; the rule tracks it at -0.03em, so each glyph
 * is about 0.57em wide. Seven glyphs at `c` cqi need `7 * 0.57 * c` percent of
 * the column, and that has to leave room for the glow.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "..", "app", "globals.css"), "utf8");

const GLYPHS = 7;
const ADVANCE_EM = 0.57;

/** One rule's declarations, comments stripped: the rule may explain the unit
 *  it replaced by name, and a scanner that read the explanation as the rule
 *  would fail on its own history. */
function block(selector: string): string {
  const open = CSS.indexOf(`\n${selector} {`);
  assert.ok(open >= 0, `${selector} rule missing from globals.css`);
  return CSS.slice(open, CSS.indexOf("}", open)).replace(/\/\*[\s\S]*?\*\//g, "");
}

test("the hero print is sized to its column, so seven digits never wrap", () => {
  const rate = block(".home-hero-rate");
  const inner = block(".home-hero-inner");

  assert.match(
    inner,
    /container-type:\s*inline-size/,
    ".home-hero-inner must be a size container, or cqi has nothing to measure",
  );
  assert.match(rate, /white-space:\s*nowrap/, "the print must never break across lines");
  assert.doesNotMatch(
    rate,
    /\d+vw/,
    "a viewport unit sizes the print to the window, not to the column it sits in",
  );

  const m = rate.match(/font-size:\s*clamp\([^)]*?([\d.]+)cqi/);
  assert.ok(m, "font-size must scale with the container (a cqi term inside clamp)");
  const share = (GLYPHS * ADVANCE_EM * Number(m[1])) / 100;
  assert.ok(
    share < 0.97,
    `seven glyphs at ${m[1]}cqi need ${(share * 100).toFixed(0)}% of the column; they wrap or clip past 97%`,
  );
});
