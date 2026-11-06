#!/usr/bin/env node
/**
 * measure-a11y.mjs — the accessibility numbers this UI holds itself to.
 *
 *   1. every text run at 4.5:1 contrast or better
 *   2. every BUTTON at least 24x24 (WCAG 2.2 SC 2.5.8)
 *   3. every keyboard focus ring at 3:1 (WCAG 2.2 SC 1.4.11)
 *   4. a skip link that is the FIRST tab stop and actually moves focus
 *   5. no unlabelled graphic left in the accessibility tree
 *
 * Sibling of measure-ui.mjs and built the same way: headless Chrome over raw
 * CDP, no dependencies, reading getComputedStyle rather than the source,
 * because the question is always what actually rendered.
 *
 * It exists because both numbers were silently wrong and neither was visible
 * from the source:
 *
 *   - `.chip` declared no `background`. A <span> has no default; a <button>
 *     has `buttonface`, which measures rgb(107,107,107). 35 chips in this app
 *     are buttons, so they rendered as grey pills on navy, and the worst
 *     contrast on the site was gold ink on that grey at 2.44:1.
 *   - `.home-hero-scroll` was rgba(...,0.55) multiplied by an opacity
 *     animation flooring at 0.5 — an effective alpha of 0.275.
 *
 * Neither is findable by reading CSS. Both are obvious the moment something
 * composites the colours the way a browser does, which is all this does.
 *
 * THREE THINGS IT GETS RIGHT ON PURPOSE, each of which it got wrong first:
 *
 *   - It multiplies every ANCESTOR's `opacity` into the foreground alpha. A
 *     container opacity composites its whole subtree and a child cannot opt
 *     out of it, so reading `color` alone misses the commonest cause of
 *     unreadable text here.
 *   - It composites the foreground OVER its background before measuring,
 *     rather than treating a translucent colour as if it were opaque.
 *   - It judges pointer size on BUTTONS only. SC 2.5.8 exempts a target "in a
 *     sentence or whose size is otherwise constrained by the line-height of
 *     non-target text", which is every address and `arcscan` link in this
 *     paper. Flagging those is crying wolf, and a gate that cries wolf is
 *     deleted.
 *
 * Disabled controls are skipped: SC 1.4.3 exempts inactive components by name,
 * and brightening one makes a disabled button look live.
 *
 * Checks 4 and 5 were added after an audit found the keyboard paying SIXTEEN
 * masthead stops before the content of every route, and they are written the
 * way they are because the first attempt at 5 was WRONG. It read each <svg>'s
 * own attributes and reported five false positives: `aria-hidden` on an
 * ANCESTOR hides the whole subtree, and no single-element check can see that.
 * So 5 asks the browser's own accessibility tree instead of the markup, which
 * is the only answer that cannot be fooled by inheritance. Check 4 likewise
 * tests ACTIVATION and not just presence: tabbing past a skip link goes to the
 * next control, so a link whose target does not exist or cannot hold focus
 * looks exactly like a working one from the outside.
 *
 * Usage:
 *   node scripts/measure-a11y.mjs                        # localhost:3000
 *   node scripts/measure-a11y.mjs --base https://…       # the live site
 *   node scripts/measure-a11y.mjs --strict               # exit 1 on a finding
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/* THREE TRAPS FOR WHOEVER WRITES THE NEXT PROBE, here rather than in anyone's
 * notes. Four of us hit the first one four times in a single session against a
 * note that already existed somewhere else, which is the argument for this
 * comment being in this file:
 *
 *   1. `innerText` APPLIES `text-transform`. A `.label` renders uppercase, so a
 *      case-sensitive search for the string in the source finds nothing and the
 *      empty result reads like a finding. Match case-insensitively, or read
 *      `textContent`. The same shape ruined a `git grep` for "NOT ON THIS
 *      CHAIN": the only hit in the repo was a comment, because the wall text is
 *      uppercased by CSS.
 *
 *   2. `/json` CAN HAND YOU THE BROWSER TARGET. Taking the first entry with a
 *      `webSocketDebuggerUrl` attaches to it intermittently, and there
 *      `innerText` silently returns empty while `Emulation.setDeviceMetricsOverride`
 *      errors. Filter `t.type === "page"`.
 *
 *   3. A PAGE AUDITED IN ONE STATE IS NOT AN AUDITED PAGE. This file's own
 *      dim-rung contrast failure hid because every rung happened to have passed
 *      when it ran; a 62px overflow needed the longest model name selected while
 *      a read was in flight; and a width pass read clean three times while the
 *      ladder was still loading. Drive the surface into the state you are
 *      auditing, and make the probe refuse to report until it is painted. */
const ROUTES = [
  "/",
  "/check?unit=%24%2F1k%20tokens&billed_usdc=0.02&quantity=10",
  "/spend",
  "/traction",
  "/developers",
  "/curve",
  "/tape",
  "/ops",
  "/loop",
  "/attack",
  "/companion",
  "/index/ACR-INF",
  /* The newest surface, and the one that showed why this list matters: a
     site-wide target-size failure on every chip that is a button went unseen
     because the page carrying nineteen of them was not audited. It is also
     the most keyboard-dense route here, since each paid row on its tape is a
     tab stop, which is why TABS below had to grow. */
  "/float",
];

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg("base", "http://127.0.0.1:3000").replace(/\/$/, "");
const CHAIN = arg("chain", "testnet");
const STRICT = process.argv.includes("--strict");
/** How far to Tab per route. See the note at the walk itself. */
const TAB_STOPS = Number(arg("tabs", "60"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs in the page. Self-contained: it is stringified and evaluated there. */
function audit() {
  const parse = (c) => {
    const m = c && c.match(/[\d.]+/g);
    if (!m) return null;
    const a = m.map(Number);
    return a.length >= 3
      ? { r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 }
      : null;
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  });
  // the nearest ancestor that actually paints; the page base is the floor
  const bgOf = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const b = parse(getComputedStyle(p).backgroundColor);
      if (b && b.a > 0.5) return b;
    }
    return { r: 0, g: 11, b: 36 };
  };
  const name = (e) => {
    const c = typeof e.className === "string" ? e.className.trim() : "";
    return e.tagName.toLowerCase() + (c ? "." + c.split(/\s+/)[0] : "");
  };

  const contrast = [];
  const targets = [];

  for (const e of document.querySelectorAll("main *, footer *, header *")) {
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    /* Text INSIDE a disabled control is exempt too, not just the control. The
       first version of this checked `button.disabled` for targets but judged
       the <span> inside it for contrast, and duly reported /ops' greyed-out
       "unlock" as a failure — a finding whose only fix is to make a dead
       button look live. */
    if (e.closest("button:disabled, input:disabled, select:disabled")) continue;
    if (!Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim()))
      continue;

    const fg0 = parse(cs.color);
    if (!fg0) continue;
    // every ancestor's opacity multiplies in: a subtree cannot opt out of it
    let op = 1;
    for (let p = e; p; p = p.parentElement) {
      const o = parseFloat(getComputedStyle(p).opacity);
      if (!isNaN(o)) op *= o;
    }
    const bg = bgOf(e);
    const L1 = lum(over({ ...fg0, a: fg0.a * op }, bg));
    const L2 = lum(bg);
    const cr = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    if (cr < need)
      contrast.push({
        el: name(e),
        text: e.textContent.trim().slice(0, 36),
        ratio: +cr.toFixed(2),
        need,
        size: cs.fontSize,
      });
  }

  for (const e of document.querySelectorAll("button")) {
    if (e.disabled) continue; // SC 1.4.3/2.5.8 exempt inactive components
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.height < 24 || r.width < 24)
      targets.push({
        el: name(e),
        text: (e.textContent || "").trim().slice(0, 28),
        h: Math.round(r.height),
        w: Math.round(r.width),
      });
  }

  const uniq = (xs, k) => {
    const seen = new Set();
    return xs.filter((x) => (seen.has(k(x)) ? false : (seen.add(k(x)), true)));
  };
  return {
    contrast: uniq(contrast, (x) => x.el + x.ratio).slice(0, 12),
    targets: uniq(targets, (x) => x.el + x.h).slice(0, 12),
  };
}

/**
 * The ring on whatever has focus right now. Self-contained because it is
 * stringified, which is why the colour helpers appear twice in this file.
 *
 * This reads the element the KEYBOARD reached, never one we focused from
 * script: `:focus-visible` is the rule that carries the ring, and Chrome does
 * not reliably match it for a programmatic `.focus()`. The caller drives real
 * Tab presses through Input.dispatchKeyEvent.
 */
function focusProbe() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  if (el.closest("button:disabled, input:disabled, select:disabled")) return null;
  const parse = (c) => {
    const m = c && c.match(/[\d.]+/g);
    if (!m) return null;
    const a = m.map(Number);
    return a.length >= 3 ? { r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 } : null;
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const bgOf = (e) => {
    for (let p = e; p; p = p.parentElement) {
      const b = parse(getComputedStyle(p).backgroundColor);
      if (b && b.a > 0.5) return b;
    }
    return { r: 0, g: 11, b: 36 };
  };
  const cs = getComputedStyle(el);
  const name =
    el.tagName.toLowerCase() +
    (typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/)[0]
      : "");
  const label = (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 28);
  const width = parseFloat(cs.outlineWidth) || 0;
  /* A box-shadow ring is a legitimate alternative to an outline, so a element
     wearing one is not reported for want of an outline. */
  const hasShadowRing = cs.boxShadow && cs.boxShadow !== "none";
  if (cs.outlineStyle === "none" || width === 0) {
    return hasShadowRing ? null : { el: name, label, reason: "no visible focus ring" };
  }
  const fg = parse(cs.outlineColor);
  if (!fg) return null;
  const bg = bgOf(el);
  const over = {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  };
  const L1 = lum(over), L2 = lum(bg);
  const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  // SC 1.4.11 Non-text Contrast: a focus indicator needs 3:1.
  if (ratio < 3)
    return { el: name, label, ratio: +ratio.toFixed(2), reason: "focus ring below 3:1" };
  return null;
}

/**
 * The keyboard's current stop, reduced to the two facts the skip-link check
 * needs: what it is, and whether it is a link that jumps to the content.
 */
function stopProbe() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const main = document.querySelector("main");
  const href = el.getAttribute ? el.getAttribute("href") || "" : "";
  let skips = false;
  if (el.tagName === "A" && href.startsWith("#") && href.length > 1) {
    const t = document.getElementById(href.slice(1));
    skips = !!(t && main && (t === main || t.contains(main) || main.contains(t)));
  }
  return {
    el:
      el.tagName.toLowerCase() +
      (typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/)[0]
        : ""),
    label: (el.getAttribute("aria-label") || el.textContent || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 28),
    inMain: !!(main && main.contains(el)),
    skips,
  };
}

/**
 * Activation, not presence. Clicking the link runs the browser's own fragment
 * navigation, which is what Enter does, and focus should end up in <main> —
 * that is what `tabIndex={-1}` on the target buys. A link pointing at an id
 * that does not exist still renders and still focuses; only this notices.
 */
function skipActivate() {
  const a = document.querySelector("a.skip-link");
  if (!a) return { reason: "no skip link in the document" };
  const href = a.getAttribute("href") || "";
  const t = href.startsWith("#") ? document.getElementById(href.slice(1)) : null;
  if (!t) return { reason: `skip link points at ${href || "nothing"}, which does not exist` };
  a.focus();
  a.click();
  const el = document.activeElement;
  const main = document.querySelector("main");
  if (el && main && (el === main || main.contains(el))) return null;
  return {
    reason: `activating the skip link left focus on ${el ? el.tagName.toLowerCase() : "nothing"}`,
  };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`${method} timed out`));
      }, 45000);
    });
  }
  async call(fn) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(${fn.toString()})()`,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || "eval threw");
    return r.result.value;
  }
}

/**
 * Unlabelled graphics, asked of the accessibility tree rather than of the DOM.
 * `ignored` is the browser's own verdict on whether a node reaches assistive
 * tech, so decorative art hidden by an ancestor's aria-hidden never appears
 * here and needs no special case.
 */
async function graphicsFindings(cdp) {
  const ROLES = new Set([
    "image",
    "graphics-document",
    "graphics-object",
    "graphics-symbol",
  ]);
  let nodes = [];
  try {
    ({ nodes = [] } = await cdp.send("Accessibility.getFullAXTree", {}));
  } catch {
    return [];
  }
  const out = [];
  for (const n of nodes) {
    if (n.ignored) continue;
    const role = n.role && n.role.value;
    if (!ROLES.has(role)) continue;
    if (((n.name && n.name.value) || "").trim()) continue;
    out.push({ role, reason: "graphic with no accessible name" });
  }
  return out;
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "acr-a11y-"));
  const port = 9100 + Math.floor(Math.random() * 300);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--no-first-run",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let bad = 0;
  try {
    let target = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !target) {
      await sleep(300);
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      } catch {
        /* chrome still starting */
      }
    }
    if (!target) throw new Error("no CDP page target after 20s");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("ws failed")), { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Accessibility.enable");
    await cdp.send("Network.setCookie", {
      name: "acr-chain",
      value: CHAIN,
      domain: new URL(BASE).hostname,
      path: "/",
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    console.log(`ACR accessibility census · ${BASE} · chain ${CHAIN}\n`);
    for (const route of ROUTES) {
      await cdp.send("Page.navigate", { url: BASE + route });
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        await sleep(500);
        try {
          const ready = await cdp.send("Runtime.evaluate", {
            expression:
              '!document.querySelector(".skel-line,.skel-card") && (document.body.innerText||"").length > 700',
            returnByValue: true,
          });
          if (ready.result.value) break;
        } catch {
          /* mid-navigation */
        }
      }
      await sleep(1200);
      const r = await cdp.call(audit);

      /* Walk the keyboard path. 20 stops covers the masthead and the first
         screen of content, which is enough to catch a ring that is wrong
         globally without making this census slow. */
      const rings = [];
      const seen = new Set();
      /* The same walk answers the skip-link question: stop 1 is where a skip
         link has to be, and the stop that first lands inside <main> is what the
         chrome costs a keyboard without one. */
      let firstStop = null;
      let stopsToMain = null;
      /* Twenty was "about a screen of content" when the densest route had a
         masthead and a handful of controls. /float's tape makes every paid row
         a tab stop, so twenty now runs out inside the chrome and the page below
         it audits as clean because it was never reached. Sixty costs a few
         seconds per route and is the difference between a pass and an unread
         page. */
      for (let i = 0; i < TAB_STOPS; i++) {
        for (const type of ["rawKeyDown", "keyUp"]) {
          await cdp.send("Input.dispatchKeyEvent", {
            type,
            windowsVirtualKeyCode: 9,
            nativeVirtualKeyCode: 9,
            code: "Tab",
            key: "Tab",
          });
        }
        let f = null;
        try {
          f = await cdp.call(focusProbe);
        } catch {
          /* mid-navigation */
        }
        if (f && !seen.has(f.el + f.reason)) {
          seen.add(f.el + f.reason);
          rings.push(f);
        }
        if (stopsToMain === null) {
          let st = null;
          try {
            st = await cdp.call(stopProbe);
          } catch {
            /* mid-navigation */
          }
          if (st) {
            if (i === 0) firstStop = st;
            if (st.inMain) stopsToMain = i + 1;
          }
        }
      }
      r.rings = rings;

      /* Check 4, in two halves: the link must BE the first stop, and it must
         actually move focus when used. */
      const keyboard = [];
      if (!firstStop || !firstStop.skips) {
        keyboard.push({
          reason: `first tab stop is ${firstStop ? firstStop.el : "nothing"}, not a skip link`,
        });
      }
      let act = null;
      try {
        act = await cdp.call(skipActivate);
      } catch {
        /* mid-navigation */
      }
      if (act) keyboard.push(act);

      const graphics = await graphicsFindings(cdp);
      const n =
        r.contrast.length + r.targets.length + rings.length + keyboard.length + graphics.length;
      bad += n;
      const short = route.split("?")[0];
      console.log(`${n ? "✗" : "✓"} ${short.padEnd(16)} ${n} finding(s)`);
      for (const c of r.contrast)
        console.log(`    contrast ${c.ratio}:1 (needs ${c.need}) ${c.size} ${c.el} — ${c.text}`);
      for (const t of r.targets)
        console.log(`    target ${t.w}x${t.h} (needs 24x24) ${t.el} — ${t.text}`);
      for (const f of r.rings)
        console.log(
          `    focus ${f.ratio ? f.ratio + ":1 (needs 3)" : f.reason} ${f.el} — ${f.label}`,
        );
      for (const k of keyboard) console.log(`    keyboard ${k.reason}`);
      for (const g of graphics) console.log(`    graphic ${g.role} has no accessible name`);
      if (!keyboard.length)
        console.log(`    keyboard skip link ok · <main> is ${stopsToMain ?? ">20"} stops away`);
    }
    console.log(
      bad
        ? `\n${bad} finding(s). Text runs must reach 4.5:1, enabled buttons 24x24,\nfocus rings 3:1, a working skip link first, and no unnamed graphic.`
        : "\nevery text run reaches 4.5:1, every enabled button is at least 24x24,\nevery focus ring the keyboard reaches is at 3:1 or better, the skip link\nis the first stop and moves focus, and no unnamed graphic is exposed",
    );
  } finally {
    chrome.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  if (STRICT && bad) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`measure-a11y failed: ${e.stack || e}\n`);
  process.exit(1);
});
