import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { actionable, append, logPath, read, report, type SpendRecord } from "./spendLog.js";

/* The local record, and the one rule it exists to keep.
 *
 * `wallet_tca` can only grade a wallet that bought from ACR's own sellers. An
 * outside developer's agent paying its own vendors is invisible to it, so
 * "keep a TCA check on my agent" had no answer. This file is that answer, and
 * most of what is tested here is the line between what may be said in basis
 * points and what may be said in dollars.
 */

const tmp = (): NodeJS.ProcessEnv => ({
  ACR_SPEND_LOG: join(mkdtempSync(join(tmpdir(), "acr-log-")), "spend.jsonl"),
});

function rec(over: Partial<SpendRecord> = {}): SpendRecord {
  return {
    at: Date.now() / 1000,
    vendor: null,
    unit: "$/1k tokens",
    quantity: 1000,
    billed_usdc: 0.5,
    over_rate_bp: 100,
    par_usdc: 0.00045,
    best_usdc: null,
    best_seller: null,
    verdict: "at_par",
    saving_usdc: null,
    intent: "pay",
    basket_status: null,
    ...over,
  };
}

// ───────────────────────────────────────────────── where it lives

test("the default is the home directory, not the working directory", () => {
  /* An MCP server inherits its HOST's working directory — Claude Desktop's is
     not a project folder — so a relative default would scatter one developer's
     ledger across wherever each host happened to launch from. Asserted rather
     than written to: this suite must never touch the real path, which it did
     once and which is why the other two suites now set the variable. */
  assert.equal(logPath({}), join(homedir(), ".acr", "spend.jsonl"));
  assert.notEqual(logPath({}), logPath(tmp()));
});

test("off means off, in any case, and an explicit path wins", () => {
  assert.equal(logPath({ ACR_SPEND_LOG: "off" }), null);
  assert.equal(logPath({ ACR_SPEND_LOG: "OFF" }), null);
  assert.equal(logPath({ ACR_SPEND_LOG: " off " }), null);
  assert.equal(logPath({ ACR_SPEND_LOG: "/tmp/x.jsonl" }), "/tmp/x.jsonl");
  // Unset and empty are the same thing: the developer said nothing.
  assert.equal(logPath({ ACR_SPEND_LOG: "" }), logPath({}));
});

test("recording off writes nothing and reads empty", () => {
  const env = { ACR_SPEND_LOG: "off" };
  assert.equal(append(rec(), env), null);
  assert.deepEqual(read(env), []);
});

test("a write that cannot happen returns null rather than throwing", () => {
  /* A read-only home, a full disk, a sandboxed host. The verdict is the
     product and the record is the bonus, so a failed write must never turn a
     working price check into an error — it must say `recorded_to: null`.

     THIS TEST HUNG CI FOR WEEKS and nobody could see it. The unwritable path
     used to be `/proc/nonexistent/nope/spend.jsonl`, and `append` calls
     `mkdirSync(dir, { recursive: true })` before it writes. On macOS there is
     no `/proc`, so that fails instantly and the test passes in microseconds.
     On Linux, as root, **`mkdirSync` into `/proc` never returns** — measured
     in a node:24-bookworm-slim container, killed at 20s having neither thrown
     nor created. So the `mcp` job ran every test to green, never exited, and
     was cancelled at GitHub's six-hour ceiling; five jobs beside it were green
     and the branch looked merely slow. Ten local runs could never have found
     it, because the bug IS the platform difference.

     A path under a regular FILE is the portable way to be unwritable: a
     non-directory component gives ENOTDIR immediately, on both platforms,
     with no virtual filesystem in the way. Verified on Linux and macOS. */
  const blocker = join(mkdtempSync(join(tmpdir(), "acr-log-")), "a-file-not-a-dir");
  writeFileSync(blocker, "x");
  const env = { ACR_SPEND_LOG: join(blocker, "spend.jsonl") };
  assert.equal(append(rec(), env), null);
});

// ───────────────────────────────────────────────── round trip

test("a record round-trips, and the directory is created on first use", () => {
  const env = tmp();
  const path = append(rec({ billed_usdc: 0.25 }), env);
  assert.equal(path, env.ACR_SPEND_LOG);
  const rows = read(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].billed_usdc, 0.25);
});

test("a malformed line is skipped, not thrown on", () => {
  /* An append-only log read by a second process can always be caught
     mid-write, and one bad line must not cost the whole report. Same
     discipline as `statement.py`'s `_read_one`. */
  const env = tmp();
  append(rec({ billed_usdc: 1 }), env);
  writeFileSync(env.ACR_SPEND_LOG as string, '{"at":1,"half-writ\n', { flag: "a" });
  append(rec({ billed_usdc: 2 }), env);
  const rows = read(env);
  assert.deepEqual(rows.map((r) => r.billed_usdc), [1, 2]);
});

test("a record stays under the size the append's atomicity depends on", () => {
  /* LOAD-BEARING, not tidiness. Two MCP hosts can append to one home directory
     at once, and a single O_APPEND write is atomic on POSIX only below
     PIPE_BUF (4096 bytes). That bound is the reason `SpendRecord` is trimmed
     rather than being the whole /par response — `basket.rows` alone would
     cross it. A future field that breaks this breaks interleaving, silently. */
  const fat = rec({
    vendor: `0x${"f".repeat(40)}`,
    unit: "$/1k tokens",
    verdict: "x".repeat(200),
    saving_usdc: 1234.567891,
    intent: "x".repeat(200),
    basket_status: "x".repeat(200),
    best_seller: `0x${"a".repeat(40)}`,
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(fat) + "\n") < 4096,
    "a record must fit in one atomic append",
  );
});

// ───────────────────────────────────────────────── the bp / USDC line

test("the press's own verdict decides what is recoverable, not a second rule here", () => {
  /* THE RULE THE WHOLE FEATURE RESTS ON, and this file defers to it rather
     than reimplementing it. `par.py:474-477`: the saving is measured against
     `best`, never against `par`, because it is "the money that was actually
     available somewhere else". `over_par` is the press's word for a saving
     past its material threshold. */
  assert.ok(actionable(rec({ verdict: "over_par", saving_usdc: 0.12 })));
  assert.equal(actionable(rec({ verdict: "at_par", saving_usdc: 0.12 })), false);
  assert.equal(actionable(rec({ verdict: "under_par", saving_usdc: 0 })), false);
  assert.equal(actionable(rec({ verdict: "unbenchmarked", saving_usdc: null })), false);
  assert.equal(actionable(rec({ verdict: "over_par", saving_usdc: 0 })), false);
});

test("a vendor named by NAME is still recoverable, because real vendors are not addresses", () => {
  /* A BUG I SHIPPED AND CAUGHT AGAINST A LIVE PRESS. The first version of
     `actionable` required `best_seller` to match /^0x[0-9a-f]{40}$/, reasoning
     that a saving is only real if the seller is reachable. The first real
     quote back from `/par` named `openai/gpt-4o-mini` — a market basket prices
     real vendors, and real vendors are not on-chain addresses. That check
     reported nothing recoverable for the entire population this tool exists
     for, and every unit test passed, because every fixture I had written used
     an address. */
  assert.ok(actionable(rec({ verdict: "over_par", saving_usdc: 0.3, best_seller: "openai/gpt-4o-mini" })));
});

test("a par-only overage is reported in bp and contributes no dollars", () => {
  const r = report(
    [rec({ over_rate_bp: 900, verdict: "at_par", saving_usdc: null, best_usdc: null })],
    { days: 30, path: "/x" },
  );
  assert.equal(r.over_rate.n, 1);
  assert.equal(r.over_rate.worst_bp, 900);
  assert.equal(r.actionable.n, 0);
  assert.equal(r.actionable.could_have_paid_usdc, 0, "par must never become a dollar figure");
});

// ───────────────────────────────────────────────── the report

test("a bill at or under the going rate is not counted as over it", () => {
  const r = report(
    [rec({ over_rate_bp: 0 }), rec({ over_rate_bp: -250 }), rec({ over_rate_bp: 50 })],
    { days: 30, path: "/x" },
  );
  assert.equal(r.priced, 3);
  assert.equal(r.over_rate.n, 1, "only the one actually above the rate");
});

test("an unpriced bill is counted and its reason kept, not silently dropped", () => {
  /* "38 of 42 priced" is a different and more honest statement than "42
     checked", and the reason is what a developer acts on. */
  const r = report(
    [rec(), rec({ over_rate_bp: null, basket_status: "no quotes for this unit" }),
     rec({ over_rate_bp: null, basket_status: "no quotes for this unit" })],
    { days: 30, path: "/x" },
  );
  assert.equal(r.bills_checked, 3);
  assert.equal(r.priced, 1);
  assert.deepEqual(r.unpriced, [{ reason: "no quotes for this unit", n: 2 }]);
});

test("the window excludes older bills", () => {
  const old = rec({ at: Date.now() / 1000 - 40 * 86_400, billed_usdc: 99 });
  const r = report([old, rec()], { days: 30, path: "/x" });
  assert.equal(r.bills_checked, 1);
});

test("a vendor filter narrows to that vendor", () => {
  const a = `0x${"a".repeat(40)}`;
  const b = `0x${"b".repeat(40)}`;
  const r = report([rec({ vendor: a }), rec({ vendor: b }), rec({ vendor: a })], {
    days: 30,
    vendor: a.toUpperCase(), // case must not matter: addresses are compared lower-cased
    path: "/x",
  });
  assert.equal(r.bills_checked, 2);
});

test("per-vendor overage is volume weighted, worst vendor first", () => {
  /* A $0.000001 check at 9000 bp must not outrank a real bill at 200 bp — the
     same weighting `tca.py` applies across sellers. */
  const a = `0x${"a".repeat(40)}`;
  const b = `0x${"b".repeat(40)}`;
  const r = report(
    [
      rec({ vendor: a, billed_usdc: 0.000001, over_rate_bp: 9000 }),
      rec({ vendor: a, billed_usdc: 10, over_rate_bp: 100 }),
      rec({ vendor: b, billed_usdc: 10, over_rate_bp: 500 }),
    ],
    { days: 30, path: "/x" },
  );
  assert.equal(r.by_vendor[0].vendor, b, "b is genuinely worse by volume");
  const av = r.by_vendor.find((v) => v.vendor === a);
  assert.ok((av?.over_rate_bp ?? 0) < 200, `a's tiny 9000bp check must not dominate: ${av?.over_rate_bp}`);
  assert.equal(av?.worst_bp, 9000, "but the worst single bill is still reported");
});

test("the report says these are checks, not payments", () => {
  /* The honesty line the whole feature rests on. ACR never observes whether
     any of these bills were paid; a report that implied otherwise would be
     `wallet_tca`'s confident zero in a new costume. */
  const r = report([rec()], { days: 30, path: "/x" });
  assert.match(r.note, /did not observe your payments/);
  assert.equal(r.source, "local");
});
