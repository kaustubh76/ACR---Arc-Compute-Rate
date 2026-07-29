/* Pure decision logic for the real Circle buyer route (app/api/buy/route.ts).
 *
 * Split out from the route handler so the money-path rules — how many payments,
 * which endpoints, and the spend cap — are unit-testable without the SDK,
 * network, or a Next runtime. Pure logic; the only import is the index roster
 * constant (itself pure). */

import { INDICES } from "./indices";

/** Exact-match allowlist of payable seller paths — a paid URL is only ever a
 *  string that appears here (prevents SSRF / paying an arbitrary endpoint). */
export const ALLOWED: ReadonlySet<string> = new Set<string>([
  "/prints",
  ...INDICES.flatMap((i) => [`/prints/${i}`, `/curve/${i}`, `/vol/${i}`, `/seller-scores/${i}`]),
]);

/** A gentle rotation so a multi-query run exercises several listings. */
export const ROTATION: readonly string[] = [
  "/prints/ACR-INF",
  "/curve/ACR-GPU",
  "/vol/ACR-DATA",
  "/prints",
  "/seller-scores/ACR-INF",
];

/** Clamp the requested query count to [1, 5]; non-finite → default 3.
 *  Real money moves per query, so the ceiling is deliberately low. */
export function clampCount(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.floor(n)));
}

/** Choose the target paths for a run. Caller-supplied `paths` are used ONLY
 *  when the list is non-empty AND every entry is allowlisted; otherwise the
 *  safe rotation. The result is sliced to `count` and is NEVER empty (an empty
 *  target list would make the loop pay a `/undefined` URL). */
export function chooseTargets(
  paths: string[] | null | undefined,
  count: number,
  allowed: ReadonlySet<string> = ALLOWED,
  rotation: readonly string[] = ROTATION,
): string[] {
  const useCaller = Array.isArray(paths) && paths.length > 0 && paths.every((p) => allowed.has(p));
  const source = useCaller ? (paths as string[]) : rotation;
  return source.slice(0, Math.max(1, count));
}

/** True iff paying one more query at `price` keeps cumulative spend within
 *  `cap` (a small epsilon absorbs float noise). Refuse BEFORE the breach. */
export function withinCap(spent: number, price: number, cap: number): boolean {
  return spent + price <= cap + 1e-9;
}
