#!/usr/bin/env node
/* Public Desk end-to-end — drive the REAL user-controlled flow in a browser.
 *
 * A user-controlled wallet's key is derived and held client-side behind a PIN,
 * so no server-side script can stand in for the ceremony: the only honest way
 * to prove the desk works is to drive the actual UI. This script does, and the
 * result is real Arc transactions:
 *
 *   PIN setup (SCA created) → faucet drip → approve → postCollateral → trade
 *
 * Circle's hosted UI (pw-auth.circle.com, in an iframe) is driven as a state
 * machine keyed on its data-testids rather than a fixed click sequence, because
 * the screens interleave unpredictably: PIN entry, PIN re-entry, the recovery
 * intro, the two security questions, and a per-transaction PIN confirm all
 * share one frame. Anything it doesn't recognise it simply waits on — so in a
 * headed run a human can finish a screen by hand and the script picks the flow
 * back up.
 *
 *   PLAYWRIGHT_DIR=…/node_modules HEADLESS=1 node scripts/desk_e2e.mjs
 *
 * Writes the session's wallet + observed milestones to data/desk_e2e_last.json,
 * which scripts/desk_evidence.py then confirms against the chain.
 */

import { writeFileSync, mkdirSync } from "node:fs";

/* Playwright is deliberately NOT a repo dependency — ~100MB of browser for one
 * operator-run script, and CI never drives a browser. Install it anywhere and
 * point PLAYWRIGHT_DIR at that node_modules (ESM ignores NODE_PATH, so the path
 * must be explicit). Needs Node ≥ 20. */
const pwSpec = process.env.PLAYWRIGHT_DIR
  ? `${process.env.PLAYWRIGHT_DIR}/playwright/index.js`
  : "playwright";
const pw = await import(pwSpec).catch(() => {
  console.error(
    "playwright not found — `npm i playwright && npx playwright install chromium`,\n" +
      "then re-run with PLAYWRIGHT_DIR=<that>/node_modules",
  );
  process.exit(1);
});
// A bare specifier gets CJS-interop named exports; an explicit file path does not.
const { chromium } = pw.chromium ? pw : pw.default;

const TERMINAL = process.env.TERMINAL ?? "http://127.0.0.1:3000";
// Circle rejects repeating (000000) and consecutive (123456) PINs.
const PIN = process.env.DESK_PIN ?? "284917";
const HEADLESS = process.env.HEADLESS !== "0";
const ANSWER = process.env.DESK_ANSWER ?? "arccomputerate";
const OUT = process.env.DESK_E2E_OUT ?? "data/desk_e2e_last.json";
const SHOTS = process.env.DESK_E2E_SHOTS ?? "";
// Reuse one browser profile (and therefore one desk wallet) across runs.
const PROFILE = process.env.DESK_PROFILE ?? "";
// How long a PIN entry is given to take effect before the screen is retried.
const PIN_RETRY_MS = 45_000;
// Resume an existing desk user by id (its browser profile may be long gone).
const USER_ID = process.env.DESK_USER_ID ?? "";
// "full" drives entry then exit; "withdraw" only takes money back out.
const MODE = process.env.DESK_MODE ?? "full";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = { startedAt: new Date().toISOString(), address: null, milestones: [], errors: [] };

function save() {
  const dir = OUT.split("/").slice(0, -1).join("/");
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(OUT, JSON.stringify(state, null, 2));
}

/** Did `loc` become visible within `ms`? isVisible() answers instantly about
 *  RIGHT NOW — it never waits — so every "is this step offered yet?" check has
 *  to go through waitFor. */
async function visible(loc, ms) {
  return loc
    .waitFor({ state: "visible", timeout: ms })
    .then(() => true)
    .catch(() => false);
}

/** Circle's hosted frame, or null while it is between navigations. */
function circleFrame(page) {
  return page.frames().find((f) => /circle\.com/.test(f.url())) ?? null;
}

async function shot(page, tag) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${tag}.png` }).catch(() => {});
}

/** Type the PIN with REAL key events. The six inputs are maxlength=1 and the
 *  SDK auto-advances on keystrokes — fill() sets values without ever
 *  triggering that, which is why the first attempt at this silently stalled. */
async function typePin(page, f) {
  const inputs = f.locator("input[type='password']");
  if ((await inputs.count().catch(() => 0)) < PIN.length) return false;
  await inputs.first().click({ timeout: 5000 }).catch(() => {});
  for (const d of PIN) {
    await page.keyboard.press(`Digit${d}`);
    await sleep(80);
  }
  return true;
}

/** The two security questions. Each is a downshift combobox that must be
 *  answered before its answer field un-disables and before Continue enables. */
async function answerRecoveryQuestions(f) {
  const sections = f.locator("[data-testid='question-input-section']");
  const n = await sections.count().catch(() => 0);
  if (!n) return false;
  for (let i = 0; i < n; i++) {
    const sec = sections.nth(i);
    await sec.locator("[data-testid='question-dropdown'] button").click({ timeout: 8000 });
    const opts = f.locator("ul[role='listbox'] li");
    await opts.first().waitFor({ timeout: 8000 });
    // Distinct questions per slot — Circle rejects picking the same one twice.
    await opts.nth(i).click({ timeout: 8000 });
    await sleep(400);
    const answer = sec.locator("[data-testid='answer-text-input']");
    await answer.waitFor({ state: "visible", timeout: 8000 });
    await answer.fill(`${ANSWER}${i}`, { timeout: 8000 });
    await sleep(300);
  }
  return true;
}

/** Click the footer button only when it is actually enabled — it stays
 *  clickable-looking but disabled until a screen is complete, and blocking on
 *  it is what made the first version crawl at 30s per attempt. */
async function clickFooter(f, label) {
  const btn = f.locator("[data-testid='footer-main-btn']");
  if (!(await btn.isVisible({ timeout: 500 }).catch(() => false))) return false;
  if (!(await btn.isEnabled().catch(() => false))) return false;
  const text = (await btn.innerText().catch(() => "")).trim();
  await btn.click({ timeout: 8000 }).catch(() => {});
  log(`  ${label}: clicked "${text}"`);
  return true;
}

/** Drive Circle's frame until `done()` — the generic engine behind every
 *  PIN-guarded step (setup, approve, postCollateral, trade). */
async function driveCircle(page, done, budgetMs, label) {
  const end = Date.now() + budgetMs;
  let lastScreen = "";
  let described = "";
  let pinnedAt = 0;
  while (Date.now() < end) {
    if (await done()) return true;
    const f = circleFrame(page);
    if (f) {
      const text = await f.locator("body").innerText().catch(() => "");
      const head = (text.split("\n")[0] ?? "").slice(0, 60);
      if (head && head !== lastScreen) {
        log(`  ${label} screen: ${head}`);
        lastScreen = head;
      }
      try {
        if ((await f.locator("[data-testid='question-input-section']").count()) > 0) {
          if (await answerRecoveryQuestions(f)) log(`  ${label}: answered recovery questions`);
          await sleep(600);
          await clickFooter(f, label);
          await sleep(2000);
          continue;
        }
        if ((await f.locator("input[type='password']").count()) >= PIN.length) {
          // Type ONCE per screen instance. Circle's iframe sometimes lingers on
          // "Enter your PIN" after the transaction has already gone through, and
          // hammering it re-submits into a dead screen forever — the run then
          // times out even though the chain is fine.
          if (pinnedAt && Date.now() - pinnedAt < PIN_RETRY_MS) {
            await sleep(1500);
            continue;
          }
          if (await typePin(page, f)) {
            pinnedAt = Date.now();
            log(`  ${label}: entered PIN (${head})`);
          }
          await sleep(2500);
          continue;
        }
        pinnedAt = 0; // a different screen — the next PIN prompt is a new one
        // The recovery confirmation gates Continue behind literally typing
        // "I agree" — the acknowledgement that Circle stores no answers.
        const agree = text.match(/Type\s*[“"]([^”"]+)[”"]\s*to proceed/i);
        if (agree) {
          const box = f.locator("input:not([type='password'])").first();
          if (await box.isEditable().catch(() => false)) {
            await box.fill(agree[1], { timeout: 8000 });
            log(`  ${label}: typed "${agree[1]}" to acknowledge`);
            await sleep(800);
            await clickFooter(f, label);
            await sleep(2000);
            continue;
          }
        }
        if (await clickFooter(f, label)) {
          await sleep(2000);
          continue;
        }
        // Nothing matched. Describe the screen ONCE so a stall is diagnosable
        // instead of just a timeout (Circle changes these screens over time).
        if (head !== described) {
          described = head;
          const btns = await f
            .locator("button")
            .evaluateAll((els) =>
              els.map((e) => ({
                t: (e.innerText || "").trim().slice(0, 30),
                tid: e.getAttribute("data-testid"),
                dis: e.disabled,
              })),
            )
            .catch(() => []);
          log(`  ${label}: unhandled screen "${head}" buttons=${JSON.stringify(btns)}`);
        }
      } catch {
        /* the frame navigated mid-probe — re-read it next tick */
      }
    }
    await sleep(1200);
  }
  return false;
}

/** Wait on the desk's OWN copy — the milestone is what the page says, not what
 *  we clicked, so a hand-finished PIN screen still advances the run. */
async function milestone(page, re, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const body = await page.locator("body").innerText().catch(() => "");
    if (re.test(body)) {
      state.milestones.push({ what, at: new Date().toISOString() });
      log(`✓ ${what}`);
      save();
      return body;
    }
    await sleep(1500);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** The SCA, plus the Circle userId the desk minted for this session — both are
 *  what scripts/desk_evidence.py needs to confirm the run independently.
 *  The chip renders a SHORTENED address, so read the full one off the link's
 *  title/href, and scope to the desk's own section (the oracle's address chip
 *  is on the same page). */
async function readIdentity(page) {
  return page.evaluate(() => {
    const sec = [...document.querySelectorAll("section")].find((s) =>
      /public desk|trade it yourself/i.test(s.textContent ?? ""),
    );
    const a = sec?.querySelector("a[title^='0x']") ?? null;
    const href = a?.getAttribute("href") ?? "";
    return {
      address:
        a?.getAttribute("title") ?? (href.match(/0x[0-9a-fA-F]{40}/) ?? [])[0] ?? null,
      userId: localStorage.getItem("acr-desk-user"),
    };
  });
}

/** The exit: take collateral back out. Skipped quietly when the desk offers
 *  nothing to withdraw — a stake entirely pinned behind an open position is a
 *  legitimate state, not a failure, and the desk says so on the page. */
async function runWithdraw(page) {
  const btn = page.getByRole("button", { name: /^withdraw |take back my /i }).first();
  if (!(await visible(btn, 30_000))) {
    const body = await page.locator("body").innerText().catch(() => "");
    const pinned = /is margining your|is backing the trade/i.test(body);
    log(pinned ? "  nothing free to withdraw — the stake is margining a position" : "  no withdraw offered");
    state.withdraw = { offered: false, pinned };
    return;
  }
  const label = (await btn.innerText()).trim();
  log(`clicking: ${label}`);
  state.withdraw = { offered: true, button: label };
  await btn.click();

  // Completion is the VENUE's answer, not the page's.
  //
  // Two wrong signals were tried first. The button vanishing fires instantly,
  // because its label flips to "confirming…" on click. And the desk returning
  // to its "take your stake" copy only happens on a FULL exit — after a partial
  // withdrawal (free margin above an open position) the desk correctly stays in
  // trading, so that predicate would never fire on the most interesting case.
  // Ask what the wallet can still withdraw, and wait for it to fall.
  const freeNow = async () => {
    try {
      const res = await page.request.post(`${TERMINAL}/api/desk/withdrawable`, {
        data: { address: state.address },
        timeout: 20_000,
      });
      const body = await res.json();
      return Number(body?.total_free_usdc ?? 0);
    } catch {
      return before; // unreadable this tick — don't call it done
    }
  };
  const before = await freeNow();
  log(`  withdrawable before: ${before.toFixed(4)} USDC`);
  const dropped = async () => (await freeNow()) < before - 0.005;

  await driveCircle(page, dropped, 300_000, "withdraw");
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    if (await dropped()) {
      const left = await freeNow();
      state.milestones.push({ what: "collateral withdrawn", at: new Date().toISOString() });
      log(`✓ collateral withdrawn — withdrawable ${before.toFixed(4)} → ${left.toFixed(4)} USDC`);
      save();
      await shot(page, "5-withdrawn");
      return;
    }
    await sleep(2500);
  }
  throw new Error("timed out waiting for the withdrawal to reduce the free balance");
  await shot(page, "5-withdrawn");
}

async function main() {
  // A persistent profile keeps localStorage, so a re-run RESUMES the same desk
  // user and SCA instead of minting a new one — the faucet is one drip per
  // address, so a fresh profile per attempt would burn the cap on retries.
  const viewport = { width: 1280, height: 1000 };
  const ctx = PROFILE
    ? await chromium.launchPersistentContext(PROFILE, { headless: HEADLESS, viewport })
    : await chromium.launch({ headless: HEADLESS });
  const page = PROFILE
    ? (ctx.pages()[0] ?? (await ctx.newPage()))
    : await ctx.newPage({ viewport });
  page.on("pageerror", (e) => log("  [pageerror]", String(e).slice(0, 200)));

  log(`opening ${TERMINAL}/curve`);
  // Resume a SPECIFIC desk wallet. The desk keys its session off one
  // localStorage value, so seeding it re-opens an existing user's wallet — the
  // way to reach a wallet whose browser profile is long gone (e.g. to withdraw
  // a stake left behind by an earlier run). The PIN is still required, so this
  // grants nothing the operator doesn't already hold.
  if (USER_ID) {
    await page.goto(TERMINAL, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.evaluate((id) => localStorage.setItem("acr-desk-user", id), USER_ID);
    log(`resuming desk user ${USER_ID}`);
  }

  await page.goto(`${TERMINAL}/curve`, { waitUntil: "domcontentloaded", timeout: 120_000 });

  // The desk only renders its live form once /api/futures answers, and that
  // read is slow enough on a cold cache to time out upstream — in which case
  // the section renders "read-only" and the button never appears. Reload
  // rather than fail: the next fetch usually hits a warm roster.
  const openBtn = page.getByRole("button", { name: /open a desk account|make my wallet/i });
  let opened = false;
  for (let attempt = 1; attempt <= 5 && !opened; attempt++) {
    if (await visible(openBtn, 60_000)) {
      opened = true;
      break;
    }
    log(`  desk not live yet (attempt ${attempt}) — reloading`);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 }).catch(() => {});
  }
  if (!opened) throw new Error("the desk never came live — is the press serving /futures?");
  await openBtn.click();
  log("clicked: open a desk account");

  // --- PIN setup: the ceremony that creates the SCA on Arc.
  const pinBtn = page.getByRole("button", { name: /set your PIN|choose a PIN/i });
  if (await visible(pinBtn, 60_000)) {
    await pinBtn.click();
    log("clicked: set your PIN");
    const funded = /take your \$0\.50 stake|get my 50 cents|post collateral|put up my stake|BUY /i;
    const ok = await driveCircle(
      page,
      async () => funded.test(await page.locator("body").innerText().catch(() => "")),
      360_000,
      "pin-setup",
    );
    if (!ok) log("  pin-setup: budget spent — falling through to the page's own state");
  }
  await milestone(page, /take your \$0\.50 stake|get my 50 cents|post collateral|put up my stake|BUY |withdraw /i, 180_000, "wallet ready");
  Object.assign(state, await readIdentity(page));
  log("  SCA:", state.address, "· user:", state.userId);
  save();
  await shot(page, "1-wallet");

  if (MODE === "withdraw") {
    await runWithdraw(page);
    save();
    log(`withdraw-only run complete — ${OUT}`);
    await ctx.close();
    return;
  }

  // --- faucet: a REAL custody-wallet transfer on Arc.
  const stakeBtn = page.getByRole("button", { name: /take your \$0\.50 stake|get my 50 cents/i });
  if (await visible(stakeBtn, 15_000)) {
    await stakeBtn.click();
    log("clicked: take your stake");
    await milestone(page, /post collateral|put up my stake/i, 300_000, "stake landed on-chain");
  } else {
    log("  already funded — skipping the faucet");
  }
  await shot(page, "2-funded");

  // --- approve + postCollateral: two PIN confirmations, two real txs.
  const collatBtn = page.getByRole("button", { name: /post collateral|put up my stake/i });
  if (await visible(collatBtn, 30_000)) {
    await collatBtn.click();
    log("clicked: post collateral (approve + postCollateral)");
    await driveCircle(
      page,
      async () => /BUY |SELL /i.test(await page.locator("body").innerText().catch(() => "")),
      360_000,
      "collateral",
    );
  }
  await milestone(page, /BUY |SELL /i, 120_000, "collateral posted — trading enabled");
  await shot(page, "3-collateral");

  // --- the trade: at the size the server computed from live margin.
  const buy = page.getByRole("button", { name: /^BUY /i }).first();
  await buy.waitFor({ timeout: 60_000 });
  const label = (await buy.innerText()).trim();
  log(`clicking: ${label}`);
  state.tradeButton = label;
  await buy.click();
  await driveCircle(
    page,
    async () => /\b(long|short) [\d.]+ @/i.test(await page.locator("body").innerText().catch(() => "")),
    300_000,
    "trade",
  );
  const body = await milestone(page, /\b(long|short) [\d.]+ @/i, 240_000, "position open on-chain");
  state.position = (body.match(/\b(long|short) [\d.]+ @ [\d.]+/i) ?? [])[0] ?? null;
  log("  position:", state.position);
  await shot(page, "4-position");

  await runWithdraw(page);
  save();
  log(`E2E complete — ${OUT}`);
  await ctx.close();
}

main().catch(async (e) => {
  state.errors.push(String(e?.message ?? e));
  save();
  console.error("E2E failed:", e);
  process.exit(1);
});
