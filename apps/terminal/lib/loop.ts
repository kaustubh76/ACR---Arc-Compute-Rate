/* Helpers for /loop that a test can pin without a browser. Copy stays in the
 * components (it is counted and linted there); this file is arithmetic. */

import { RATING_WINDOW_S, currentWindow } from "./humans";

/** Seconds until the rotation window that contains `nowS` ends. */
export function windowEndsInS(nowS: number): number {
  return (currentWindow(nowS) + 1) * RATING_WINDOW_S - nowS;
}

/** How many times the human-denominated bound exceeds the wallet one, or null when
 *  either side is absent/zero — a zero here means "not computed", never "free". */
export function boundMultiple(human: number | null | undefined, wallet: number | null | undefined): number | null {
  if (human == null || wallet == null || !(human > 0) || !(wallet > 0)) return null;
  return human / wallet;
}

/** Where a value sits on a shared log scale, 0..1. */
export function logFrac(value: number, lo: number, hi: number): number {
  if (!(value > 0) || !(hi > lo) || !(lo > 0)) return 0;
  const f = (Math.log10(value) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
  return Math.min(1, Math.max(0, f));
}

/** The six stations of the loop, in the order the data travels. */
export const LOOP_NODES = ["pay", "mirror", "index", "measure", "decide", "again"] as const;
export type LoopNode = (typeof LOOP_NODES)[number];
