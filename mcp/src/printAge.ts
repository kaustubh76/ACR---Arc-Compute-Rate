/** How old a number is, and whether that is still "current".
 *
 * THE THING THIS EXISTS FOR, measured against the testnet press 2026-10-10:
 * `get_rate("ACR-INF")` returned `0.4923551190903513` with `posted_at`
 * 1789450387 in the same payload — **25.05 days old**, identically for ACR-INF,
 * ACR-GPU and ACR-DATA, because that oracle stopped on 2026-09-15. A grep for
 * `stale|age|freshness` across `src/*.ts` returned nothing. So an agent asked
 * ACR for a reference rate and got a three-and-a-half-week-old one presented as
 * the answer, with the evidence of its own staleness sitting unread in the
 * response.
 *
 * `check_spend` has the same shape of problem one level up: it returns
 * "over_par, 2500 bp, ESCALATE" computed from `/par`, whose `basket.fetched_at`
 * was 4.07 days old. A verdict is only as current as the market it was compared
 * against, and an agent that escalates a bill is about to spend someone's
 * attention or money on it.
 *
 * THE TERMINAL ALREADY LEARNED THIS (`apps/terminal/lib/printAge.ts`, commit
 * c6b1912 "say how old the print is, where the number is"). This is the same
 * judgement for the surface an AGENT reads, which is the one that acts.
 *
 * WHY A COPY AND NOT AN IMPORT. `acr-mcp` publishes standalone — `files` is
 * `["dist", "README.md", "LICENSE"]` — so it cannot reach into the monorepo at
 * runtime. Same argument as `chain.ts`, and pinned the same way: the thresholds
 * are read out of the press's own `ops.py` by `printAge.test.ts`, which fails on
 * drift. The WORDING is deliberately not pinned — see `ageWords` below.
 */

/** 90 minutes. Past this a print is late — the press warns.
 *  Pinned to `PRINT_WARN_AGE_S` in `services/index_api/index_api/ops.py`. */
export const PRINT_WARN_AGE_S = 5400;

/** 2 hours, which is MAX_SETTLE_AGE: past this the venue cannot settle against
 *  the print at all, so it is not merely old, it is out of use.
 *  Pinned to `PRINT_MAX_AGE_S` in `services/index_api/index_api/ops.py`. */
export const PRINT_MAX_AGE_S = 7200;

export type PrintFreshness = "fresh" | "late" | "overdue" | "unknown";

/** How old the stamp is, and what to call that.
 *
 *  `unknown` when there is no timestamp, and it must never read as `fresh`: a
 *  payload that carried no `posted_at` is a payload that did not say, which is
 *  a different fact from "posted recently".
 */
export function printFreshness(
  postedAt: number | null | undefined,
  nowS: number = Math.floor(Date.now() / 1000),
): { state: PrintFreshness; ageS: number | null } {
  if (!postedAt || !Number.isFinite(postedAt) || !nowS) {
    return { state: "unknown", ageS: null };
  }
  const ageS = Math.max(0, nowS - postedAt);
  if (ageS > PRINT_MAX_AGE_S) return { state: "overdue", ageS };
  if (ageS > PRINT_WARN_AGE_S) return { state: "late", ageS };
  return { state: "fresh", ageS };
}

/** Whether the age is worth saying at all.
 *
 *  Only when it is news. An hourly print forty minutes old is working exactly
 *  as designed, and stamping an age on every reading would turn a signal into
 *  furniture — the same reason the terminal's keeper chip stays quiet until the
 *  chore stops.
 */
export function worthSaying(state: PrintFreshness): boolean {
  return state === "late" || state === "overdue";
}

/** An age a reader can hold in their head.
 *
 *  DELIBERATELY NOT the terminal's `ageWords`, and the pin test does not require
 *  it to be: that one tops out at `hr ago`, which turned the measured 25-day
 *  testnet print into "601 hr ago". A chip in a masthead is read by someone who
 *  already knows the print is hourly; a tool result is read by an agent with no
 *  such context, and "25 days ago" is the version that makes the decision
 *  obvious. The THRESHOLDS are what must not drift, and those are pinned.
 */
export function ageWords(ageS: number | null): string {
  if (ageS == null) return "age unknown";
  if (ageS < 90) return "just now";
  const m = Math.round(ageS / 60);
  if (m < 90) return `${m} min ago`;
  const h = ageS / 3600;
  if (h < 48) return `${Math.round(h)} hr ago`;
  return `${(h / 24).toFixed(1)} days ago`;
}

/** The staleness block a tool adds to its answer.
 *
 *  Shaped as a sibling of the payload rather than a rewrite of it: every field
 *  the press sent stays exactly where a caller already expects it, and the age
 *  arrives alongside. `fresh` and `unknown` carry no `note` — the fields are
 *  there for a caller who wants them, and the sentence is reserved for when
 *  there is something to act on.
 *
 *  `what` names the thing that is old ("this print", "the market basket"), so
 *  one sentence can be reused by tools whose numbers go stale for different
 *  reasons.
 */
export function staleness(
  stampS: number | null | undefined,
  what: string,
  nowS?: number,
): Record<string, unknown> {
  const { state, ageS } = printFreshness(stampS, nowS);
  const out: Record<string, unknown> = {
    age_s: ageS,
    age: ageWords(ageS),
    freshness: state,
    stale: state === "late" || state === "overdue",
  };
  if (state === "overdue") {
    // The press's own sentence, not a boundary invented here: `ops.py` judges
    // the same question and /ops renders "past the settle window".
    out.note =
      `${what} is ${ageWords(ageS)} — past the settle window ` +
      `(${PRINT_MAX_AGE_S / 3600} hr), so it is not a current reading. ` +
      `Treat it as the last known value, not as today's.`;
  } else if (state === "late") {
    out.note = `${what} is ${ageWords(ageS)}, past the ${PRINT_WARN_AGE_S / 60}-minute warning age but still inside the settle window.`;
  } else if (state === "unknown") {
    out.note = `${what} carried no timestamp, so its age could not be checked.`;
  }
  return out;
}
