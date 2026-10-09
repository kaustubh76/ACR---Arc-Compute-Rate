import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/* The running record of what this agent was told about its own bills.
 *
 * WHY THIS EXISTS. `my_tca` — now `wallet_tca` — can only grade a wallet that
 * bought from ACR's own sellers, because it reads settlements mirrored from
 * ACR's x402 paywall. An outside developer's agent paying its own vendors is
 * invisible to it, and used to get the most reassuring possible answer:
 * `purchases: 0, spent_usdc: 0.0`. `check_spend` is the one tool that works on
 * a bill ACR has never seen, and it was stateless — one bill, one verdict,
 * nothing accumulated. So "keep a TCA check on my agent" had no answer.
 *
 * This is that answer, and it is deliberately LOCAL. ACR does not need a copy
 * of a business's vendor ledger to tell it what a fair price is, so it does not
 * get one. Nothing here is uploaded, by this file or any other.
 *
 * WHAT IT IS NOT. These are bills somebody ASKED ACR TO PRICE. ACR never
 * observes whether they were paid, at what price, or at all. A report built
 * from this must say so every time, or it becomes the same confident fiction in
 * a new costume.
 *
 * ON BY DEFAULT, AND NEVER SILENT. A tool that quietly starts writing a file of
 * your vendor bills to your home directory is a surprise, and a README is not
 * consent — most people never open one. So every `check_spend` response carries
 * `recorded_to`, which is the path or `null`, on the answer the developer is
 * already reading. `ACR_SPEND_LOG=off` turns it off.
 */

/** Where the record lives, or `null` when the developer has turned it off.
 *
 *  HOME, NOT CWD. An MCP server inherits its host's working directory — Claude
 *  Desktop's is not a project, and a relative path would scatter one ledger
 *  across every directory a host happened to launch from.
 */
export function logPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.ACR_SPEND_LOG ?? "").trim();
  if (raw.toLowerCase() === "off") return null;
  if (raw) return raw;
  return join(homedir(), ".acr", "spend.jsonl");
}

/** One checked bill. Only what a report needs.
 *
 *  TRIMMED ON PURPOSE, and the reason is the append below: `basket.rows` can be
 *  dozens of quotes, and a long line is the one thing that breaks the
 *  concurrency story. Everything here comes straight off the `/par` response
 *  (`app.py`'s `price_check`) or `par.as_dict()`.
 */
export interface SpendRecord {
  at: number;
  vendor: string | null;
  unit: string;
  quantity: number;
  billed_usdc: number;
  /** How far over the going rate, in bp. From `par` — the SOFT measure. */
  over_rate_bp: number | null;
  par_usdc: number | null;
  /** The cheapest independent offer, and who made it.
   *
   *  `best_seller` IS NOT AN ADDRESS, and assuming it was is a bug I shipped
   *  and caught against a live press: a real market quote names a vendor, and
   *  the first one back was `openai/gpt-4o-mini`. Requiring `0x…` here reported
   *  nothing recoverable for every real-world bill, which is the entire
   *  population this tool is for. It is a label; treat it as one. */
  best_usdc: number | null;
  best_seller: string | null;
  /** The press's own verdict: `over_par` | `at_par` | `under_par` |
   *  `unbenchmarked`. `over_par` is its word for materially recoverable. */
  verdict: string | null;
  /** The press's own recoverable figure, in USDC.
   *
   *  TAKEN, NOT RECOMPUTED. `par.py:510-512` already measures this against
   *  `best` and never against `par`, applies the material-bp threshold, and
   *  scales a per-unit benchmark back out over the quantity. Recomputing it
   *  here would be a second copy of the one rule that must not drift, and my
   *  first attempt got it wrong in two different ways. */
  saving_usdc: number | null;
  intent: string | null;
  /** Why a bill could not be priced, when it could not be. */
  basket_status: string | null;
}

/** Append one record, and return where it went — or `null` if recording is off.
 *
 *  ATOMICITY, AND THE BOUND IT DEPENDS ON. Two MCP hosts can run at once
 *  (Claude Desktop and Claude Code against the same home directory), so two
 *  processes can append to this file concurrently. A single `write` to a file
 *  opened `O_APPEND` is atomic on POSIX only while it stays under `PIPE_BUF`,
 *  which is 4096 bytes. That is why `SpendRecord` is trimmed rather than being
 *  the whole `/par` response: the size bound is load-bearing, not tidiness.
 *
 *  A record that would exceed it is still written — a truncated ledger is worse
 *  than an interleaved line, and `read` already tolerates a bad line — but the
 *  cap is asserted in the tests so a future field cannot quietly cross it.
 *
 *  NEVER THROWS. A read-only home directory, a full disk or a sandbox must not
 *  turn a working price check into an error: the verdict is the product and the
 *  record is the bonus. A failure returns `null`, which `check_spend` reports as
 *  `recorded_to: null` rather than claiming a write that did not happen.
 */
export function append(rec: SpendRecord, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = logPath(env);
  if (!path) return null;
  try {
    /* 0700 / 0600, APPLIED AT CREATION. A business's vendor list under the
       default 0644 is world-readable on a shared box, which is a surprising
       way for a convenience to become a disclosure. Both are no-ops on
       Windows and neither re-tightens a file that already exists — say that
       rather than imply protection this does not have. */
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify(rec) + "\n", { encoding: "utf8", flag: "a", mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

/** Every record, oldest first. A malformed line is skipped, never thrown on.
 *
 *  The same discipline as `statement.py`'s `_read_one`: an append-only log read
 *  by a different process can always be caught mid-write, and one bad line must
 *  not cost a developer the whole report.
 */
export function read(env: NodeJS.ProcessEnv = process.env): SpendRecord[] {
  const path = logPath(env);
  if (!path) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return []; // no file yet is the normal first-run state, not an error
  }
  const out: SpendRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as SpendRecord;
      if (row && typeof row.at === "number") out.push(row);
    } catch {
      /* a half-written line, or something that is not ours */
    }
  }
  return out;
}

/** Was there money actually recoverable on this bill?
 *
 *  THE RULE THIS WHOLE FILE IS ORGANISED AROUND, and it is the PRESS'S rule,
 *  deferred to rather than reimplemented. `par.py:474-477`: the saving is
 *  "measured against `best`, never against `par` — it is the money that was
 *  actually available somewhere else. A price above the median with nothing
 *  cheaper on offer is dear, not recoverable, and calling that a saving would
 *  be inventing one." `over_par` is the press's word for a saving that cleared
 *  its material-bp threshold.
 *
 *  `anchors/GAP.md` is the reason any of this is careful: ACR's index
 *  reference levels sit 20x to 1250x off real market prices, so a dollar
 *  figure built from the index — or from `par` — is indefensible the moment a
 *  reviewer opens it. Basis points survive that; dollars do not.
 */
export function actionable(r: SpendRecord): boolean {
  return r.verdict === "over_par" && typeof r.saving_usdc === "number" && r.saving_usdc > 0;
}

export interface SpendReport {
  available: true;
  source: "local";
  path: string | null;
  window_days: number;
  bills_checked: number;
  priced: number;
  unpriced: { reason: string; n: number }[];
  over_rate: { n: number; median_bp: number | null; worst_bp: number | null };
  actionable: { n: number; could_have_paid_usdc: number; basis: string; note: string };
  by_vendor: {
    vendor: string;
    bills: number;
    billed_usdc: number;
    over_rate_bp: number | null;
    worst_bp: number | null;
  }[];
  note: string;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** USDC is an integer of millionths — the same rule `pay.ts` states for the
 *  budget cap, and for the same reason: a running total summed in floating
 *  point is wrong at the boundary, and this one is going in front of a reader
 *  as a dollar figure. */
const MICRO = 1_000_000;
const round6 = (n: number): number => Math.round(n * MICRO) / MICRO;

/** Fold the record into the running answer. */
export function report(
  rows: SpendRecord[],
  opts: { days: number; vendor?: string; path: string | null },
): SpendReport {
  const since = Date.now() / 1000 - opts.days * 86_400;
  const want = (opts.vendor ?? "").trim().toLowerCase();
  const inWindow = rows.filter(
    (r) => r.at >= since && (!want || (r.vendor ?? "").toLowerCase() === want),
  );

  const priced = inWindow.filter((r) => typeof r.over_rate_bp === "number");
  const reasons = new Map<string, number>();
  for (const r of inWindow) {
    if (typeof r.over_rate_bp === "number") continue;
    const why = r.basket_status || "no published prices for this unit";
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }

  // OVER the rate, not merely priced: a bill at or under the going rate is the
  // good case and does not belong in a count of problems.
  const over = priced.filter((r) => (r.over_rate_bp as number) > 0);
  const overBps = over.map((r) => r.over_rate_bp as number);

  const act = inWindow.filter(actionable);
  const couldHavePaid = act.reduce((sum, r) => sum + (r.saving_usdc as number), 0);

  const byVendor = new Map<string, SpendRecord[]>();
  for (const r of inWindow) {
    const key = r.vendor ?? "(no vendor given)";
    byVendor.set(key, [...(byVendor.get(key) ?? []), r]);
  }

  const vendors = [...byVendor.entries()]
    .map(([vendor, rs]) => {
      const billed = rs.reduce((s, r) => s + r.billed_usdc, 0);
      // VOLUME-WEIGHTED, so a $0.000001 check cannot outweigh a real bill —
      // the same weighting `tca.py` applies to slippage across sellers.
      const weighted = rs
        .filter((r) => typeof r.over_rate_bp === "number")
        .reduce((s, r) => s + (r.over_rate_bp as number) * r.billed_usdc, 0);
      const weight = rs
        .filter((r) => typeof r.over_rate_bp === "number")
        .reduce((s, r) => s + r.billed_usdc, 0);
      const bps = rs
        .filter((r) => typeof r.over_rate_bp === "number")
        .map((r) => r.over_rate_bp as number);
      return {
        vendor,
        bills: rs.length,
        billed_usdc: round6(billed),
        over_rate_bp: weight > 0 ? Math.round((weighted / weight) * 10) / 10 : null,
        worst_bp: bps.length ? Math.max(...bps) : null,
      };
    })
    .sort((a, b) => (b.over_rate_bp ?? -Infinity) - (a.over_rate_bp ?? -Infinity));

  return {
    available: true,
    source: "local",
    path: opts.path,
    window_days: opts.days,
    bills_checked: inWindow.length,
    priced: priced.length,
    unpriced: [...reasons.entries()].map(([reason, n]) => ({ reason, n })),
    over_rate: {
      n: over.length,
      median_bp: median(overBps),
      worst_bp: overBps.length ? Math.max(...overBps) : null,
    },
    actionable: {
      n: act.length,
      could_have_paid_usdc: round6(couldHavePaid),
      basis: "the cheapest reachable independent offer at the time of each check",
      note: "a suggestion, not a promise",
    },
    by_vendor: vendors,
    note:
      "these are bills you asked ACR to price. ACR did not observe your payments, " +
      "so this is a record of checks, not of money that moved.",
  };
}
