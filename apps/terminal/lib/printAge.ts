/* How old the on-chain print is, and whether that is still "live".
 *
 * THE THING THIS EXISTS FOR, measured on the live site 2026-10-10: the home
 * page read `ACR-INF ⛓ on-chain · live 0.49533` over a print whose `posted_at`
 * was 8.2 days old, and the masthead read `PUBLISHED 05:18:03 UTC` with no
 * date. Searching the rendered page for "days ago", "stale" or "out of date"
 * returned nothing. Meanwhile /ops — one unlinked page away — reported
 * `ACR-INF: last print 11810 min ago · past the settle window`.
 *
 * The press wallet is at 0.005 USDC against a 1.0 floor, so it cannot post.
 * That is a real outage, correctly detected, and the surface everybody lands
 * on was badging its consequence as live. A reference rate's whole claim is
 * that it is current; a stale one presented as current is the worst thing this
 * site can say, because every other number is derived from it.
 *
 * THE THRESHOLDS ARE THE PRESS'S OWN, not a guess. `ops.py` judges the same
 * question with PRINT_WARN_AGE_S / PRINT_MAX_AGE_S and says "past the settle
 * window"; two surfaces inventing two boundaries would disagree about whether
 * a print is late, and the one a reader trusts would be the one with no
 * reasoning behind it. `printAge.test.ts` reads ops.py and fails if they drift.
 */

/** 90 minutes. Past this a print is late — the press warns. */
export const PRINT_WARN_AGE_S = 5400;

/** 2 hours, which is MAX_SETTLE_AGE: past this the venue cannot settle against
 *  the print at all, so it is not merely old, it is out of use. */
export const PRINT_MAX_AGE_S = 7200;

export type PrintFreshness = "fresh" | "late" | "overdue" | "unknown";

/** How old the print is, and what to call that.
 *
 *  `unknown` when there is no timestamp or no clock yet — and it must not
 *  render as `fresh`. `useNow()` returns 0 during SSR on purpose (a wall-clock
 *  age computed on the server differs from the client and breaks hydration), so
 *  the first paint legitimately cannot tell, and saying nothing is the honest
 *  answer for that instant.
 */
export function printFreshness(
  postedAt: number | null | undefined,
  nowS: number,
): { state: PrintFreshness; ageS: number | null } {
  if (!postedAt || !Number.isFinite(postedAt) || !nowS) {
    return { state: "unknown", ageS: null };
  }
  const ageS = Math.max(0, nowS - postedAt);
  if (ageS > PRINT_MAX_AGE_S) return { state: "overdue", ageS };
  if (ageS > PRINT_WARN_AGE_S) return { state: "late", ageS };
  return { state: "fresh", ageS };
}

/** The clock to judge a print against, when a wall clock may not exist yet.
 *
 *  THE FLASH THIS FIXES, caught in the live DOM on 2026-10-10 by reading the
 *  same page twice. `useNow()` returns 0 for the SSR and hydration frames on
 *  purpose — a wall-clock age rendered on the server differs from the client
 *  and breaks hydration — and `printFreshness` correctly calls that `unknown`.
 *  But `HomeHero`'s badge falls through on `unknown` to its unconditional
 *  `on-chain · live` chip, with a breathing dot. So for the whole hydration
 *  frame the front page claimed a 25-day-old print was live, over exactly the
 *  pulse this project calls "the one signal worse than none". Two reads 0.4s
 *  apart landed either side of the commit and disagreed, which is how it
 *  surfaced.
 *
 *  The envelope's `fetchedAt` solves it without reintroducing the mismatch: it
 *  is DATA, identical on the server and in the hydration frame, so the right
 *  chip renders from the first paint. Once the live clock is running it wins,
 *  because then the age keeps growing while the tab stays open.
 *
 *  `nowS || …` and not `??`: `useNow()`'s server value is 0, not null.
 */
export function freshnessClock(nowS: number, fetchedAtMs?: number): number {
  if (nowS > 0) return nowS;
  const s = Math.floor((fetchedAtMs ?? 0) / 1000);
  return s > 0 ? s : 0;
}

/** Whether the age should be shown at all.
 *
 *  Only when it is news. An hourly print that is forty minutes old is working
 *  exactly as designed, and stamping an age on every reading would turn a
 *  signal into furniture — the same reason `ChainStrip`'s keeper chip is quiet
 *  until the chore stops.
 */
export function worthSaying(state: PrintFreshness): boolean {
  return state === "late" || state === "overdue";
}
