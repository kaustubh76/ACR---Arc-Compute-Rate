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

/** 30 days — and a DIFFERENT question, which is the whole reason it is here.
 *
 *  THE BUG THIS CONSTANT EXISTS TO UNDO. The first version of this file had one
 *  pair of thresholds and one `staleness(stamp, what)`, where the only thing a
 *  caller chose was a noun. So `check_spend`'s market basket was judged against
 *  the venue's settle window, and a basket 4.07 days old came back
 *  `stale: true, freshness: "overdue", "past the settle window (2 hr)"` — a
 *  verdict on a boundary 360x too tight, in a sentence about a venue that does
 *  not settle against a price list.
 *
 *  The press is the judge and it disagrees. `par.py` declares
 *  `ANCHOR_MAX_AGE_S` and argues it: `anchors.py --fetch` is "network; manual,
 *  never CI", so nothing refreshes a basket on a timer, and "a list price does
 *  not move daily, so thirty days is generous rather than tight — the point is
 *  that the staleness has a name". Past it `market_basket()` returns
 *  `status="STALE"` with no quotes, which makes the basket unusable and switches
 *  who the bill is benchmarked against.
 *
 *  Pinned to `ANCHOR_MAX_AGE_S` in `services/index_api/index_api/par.py`, and
 *  `printAge.test.ts` also asserts it is not equal to the print's window — so
 *  the two cannot quietly collapse back into one pair. */
export const ANCHOR_MAX_AGE_S = 30 * 86_400;

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

/** The age fields every staleness block carries, whatever is being judged. */
function ageBlock(ageS: number | null): Record<string, unknown> {
  return { age_s: ageS, age: ageWords(ageS) };
}

/** How old an ON-CHAIN PRINT is, judged against the venue's settle window.
 *
 *  Shaped as a sibling of the payload rather than a rewrite of it: every field
 *  the press sent stays exactly where a caller already expects it, and the age
 *  arrives alongside. `fresh` and `unknown` carry no `note` — the fields are
 *  there for a caller who wants them, and the sentence is reserved for when
 *  there is something to act on.
 *
 *  NAMED FOR WHAT IT JUDGES, not parameterised by a noun. The version this
 *  replaced took a `what` string and applied these thresholds to anything a
 *  caller passed, which is how a market basket came to be measured against a
 *  settle window. A boundary and the thing it governs belong in the same name.
 */
export function printStaleness(
  postedAt: number | null | undefined,
  nowS?: number,
): Record<string, unknown> {
  const { state, ageS } = printFreshness(postedAt, nowS);
  const out: Record<string, unknown> = {
    ...ageBlock(ageS),
    freshness: state,
    stale: state === "late" || state === "overdue",
  };
  if (state === "overdue") {
    // The press's own sentence, not a boundary invented here: `ops.py` judges
    // the same question and /ops renders "past the settle window".
    out.note =
      `this print is ${ageWords(ageS)} — past the settle window ` +
      `(${PRINT_MAX_AGE_S / 3600} hr), so it is not a current reading. ` +
      `Treat it as the last known value, not as today's.`;
  } else if (state === "late") {
    out.note = `this print is ${ageWords(ageS)}, past the ${PRINT_WARN_AGE_S / 60}-minute warning age but still inside the settle window.`;
  } else if (state === "unknown") {
    out.note = "this print carried no timestamp, so its age could not be checked.";
  }
  return out;
}

/** How old the MARKET BASKET is — reported, and judged by the press.
 *
 *  THE SPLIT THAT MATTERS. The age is ours to report: it is a fact, and an
 *  agent that wants a tighter rule than 30 days needs the number in order to
 *  apply one. The VERDICT is the press's: `/par` already carries
 *  `basket.status` — `"ok"`, `"STALE"`, `"ABSENT"`, `"NO_ROWS"` — computed
 *  against `ANCHOR_MAX_AGE_S` by the same code that decides whether the basket
 *  is usable at all and, when it is not, switches who the bill is benchmarked
 *  against. Two surfaces answering "is this basket stale" on two boundaries is
 *  the thing being removed, not added.
 *
 *  So `status` decides, and our own window is the FALLBACK — reached only when
 *  a press is too old to send one, which is the same deployment-skew case
 *  `check_spend` already handles for a press with no `/par` at all.
 */
export function basketStaleness(
  fetchedAt: number | null | undefined,
  pressStatus?: unknown,
  nowS?: number,
): Record<string, unknown> {
  const now = nowS ?? Math.floor(Date.now() / 1000);
  const ageS = fetchedAt && Number.isFinite(fetchedAt) ? Math.max(0, now - fetchedAt) : null;
  const status = typeof pressStatus === "string" ? pressStatus.trim() : "";
  const out: Record<string, unknown> = { ...ageBlock(ageS), status: status || null };

  if (status && status.toLowerCase() !== "ok") {
    // The press refused this basket. Pass its own word through rather than
    // re-deriving a verdict from the age — a basket can be ABSENT or NO_ROWS at
    // any age, and those are not staleness at all.
    out.stale = status.toUpperCase() === "STALE";
    out.note =
      `the press reports this basket as ${status}` +
      (ageS === null ? "" : `, fetched ${ageWords(ageS)}`) +
      ". Its comparison fell back to whatever `benchmarked_against` names, " +
      "so read that before trusting the verdict.";
    return out;
  }

  if (ageS === null) {
    out.stale = false;
    out.note = "the basket carried no timestamp, so its age could not be checked.";
    return out;
  }

  // Either the press said "ok" — in which case this agrees with it by
  // construction, since it judged the same number against the same window — or
  // it said nothing, and this is the fallback.
  out.stale = ageS > ANCHOR_MAX_AGE_S;
  if (out.stale) {
    out.note =
      `the market basket was fetched ${ageWords(ageS)}, past the ${ANCHOR_MAX_AGE_S / 86_400}-day ` +
      "anchor window. These prices are refreshed by hand (`anchors.py --fetch` is manual, " +
      "never CI), so an old basket means nobody has run it recently.";
  }
  return out;
}
