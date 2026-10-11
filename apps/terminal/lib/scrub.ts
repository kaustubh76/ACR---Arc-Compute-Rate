import { editionLabel } from "./format";

/* Scrubbing the front page's print through its own history: the arithmetic.
 *
 * The charts' crosshair (`components/charts/useCrosshair.ts`) resolves a
 * pointer to the nearest data index and steps it with the arrow keys; this is
 * the same contract for an HTML element rather than an SVG, kept pure so a
 * test can hold it. The hook that wires it is `lib/useScrub.ts`.
 */

/** Nearest index for a pointer `px` pixels into an element `width` wide, or
 *  null when there is nothing to scrub (fewer than two points, no width). */
export function scrubIndex(px: number, width: number, n: number): number | null {
  if (n < 2 || !(width > 0)) return null;
  const t = Math.min(1, Math.max(0, px / width));
  return Math.round(t * (n - 1));
}

/** The next index for a key, `null` to clear, or `undefined` for a key this
 *  does not handle (so the caller lets it pass through). Left from nothing
 *  starts at the newest point; right from nothing starts at the oldest. */
export function stepScrub(idx: number | null, key: string, n: number): number | null | undefined {
  if (n < 2) return undefined;
  const last = n - 1;
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, (idx ?? n) - 1);
    case "ArrowRight":
      return Math.min(last, (idx ?? -1) + 1);
    case "Home":
      return 0;
    case "End":
      return last;
    case "Escape":
      return null;
    default:
      return undefined;
  }
}

/** The docked caption for a scrubbed point: which fixing it was, and how many
 *  fixings back from the newest. `ts` is sim-seconds, so the edition number is
 *  the only honest name for it; never a date. */
export function scrubCaption(points: ReadonlyArray<{ ts: number }>, idx: number): { label: string; ago: number } {
  return { label: editionLabel(points[idx].ts), ago: points.length - 1 - idx };
}
