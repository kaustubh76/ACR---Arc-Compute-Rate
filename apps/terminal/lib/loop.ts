/* Helpers for /loop that a test can pin without a browser. Copy stays in the
 * components (it is counted and linted there); this file is arithmetic. */

/** Where a value sits on a shared log scale, 0..1. */
export function logFrac(value: number, lo: number, hi: number): number {
  if (!(value > 0) || !(hi > lo) || !(lo > 0)) return 0;
  const f = (Math.log10(value) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
  return Math.min(1, Math.max(0, f));
}

/** The six stations of the loop, in the order the data travels. */
export const LOOP_NODES = ["pay", "mirror", "index", "measure", "decide", "again"] as const;
export type LoopNode = (typeof LOOP_NODES)[number];
