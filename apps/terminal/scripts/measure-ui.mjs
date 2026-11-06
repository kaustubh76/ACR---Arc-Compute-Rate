#!/usr/bin/env node
/**
 * measure-ui.mjs — an objective census of the terminal's typography and geometry.
 *
 * "It looks better" is not a result. This drives headless Chrome over raw CDP and
 * counts the things the eye only feels: how many distinct font sizes a page sets, how
 * many distinct spacing values, how many section heads draw the gold chapter bar, where
 * charts put their left gutter, and whether anything escapes the viewport.
 *
 * Dependency-free on purpose: Node ships a global WebSocket and fetch, and this repo has
 * no playwright. Lives in scripts/ (not lib/) so `npm test` never collects it, and is
 * .mjs (not .tsx) so coverage.test.ts never sees it.
 *
 * Four traps this is written around, each of which produces a confident wrong number:
 *   1. `next dev` does not hydrate on this machine — measure a `next build && next start`.
 *   2. /json lists service workers and the devtools page, and attaching to a non-page
 *      target succeeds and then answers every command about an empty body. Filter on
 *      type === "page" AND a webSocketDebuggerUrl.
 *   3. A fixed sleep photographs the skeleton. Poll for real payload text instead.
 *   4. A reused profile serves the previous build's chunks, so you grade the old code.
 *      Fresh mkdtemp profile every run, random port, browser killed in a finally.
 *
 * Usage:
 *   node scripts/measure-ui.mjs --out before.md
 *   node scripts/measure-ui.mjs --base https://arc-compute-rate.vercel.app --out live.md
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Pages honour ONLY the acr-chain cookie (lib/chainChoice.ts:56); ?chain= is for the API
// routes. The edition, by contrast, does travel as ?edition= (lib/edition.ts:11), and the
// pre-paint boot script persists it — so the edition needs no injected script.
const CHAIN_COOKIE = "acr-chain";

/**
 * Each route carries the text that ONLY its loaded state has. A generic predicate is
 * worthless here: `/spend` with no business selected renders a heading and a standfirst,
 * passes any length test, and reports two font sizes and one section head — a census of
 * the empty state, which is not the page anyone complained about. Same discipline as
 * scripts/rehearse_pages.py, which pairs a render anchor with a data regex.
 *
 * The operator pages (/spend, /traction) only have data on testnet, so run them with
 * --chain testnet. /check needs its inputs in the query string to produce a verdict.
 *
 * PICK A TOKEN A TRANSLATOR CANNOT TOUCH. Every gate here must match in BOTH editions,
 * so it has to be data rather than prose: a price symbol, an index id, a unit. This has
 * now been got wrong twice. First the gates keyed on expert sentences, and because the
 * plain edition hides expert copy from innerText, 85 of 120 cells timed out on pages that
 * had rendered perfectly. Then /tape and /loop kept "USDC" — which LOOKS like data and is
 * not: the plain edition prints neither page's amounts that way, so 10 more cells reported
 * a healthy page as never rendered. They gate on `$` now, which is in the rendered price
 * either way.
 */
const ROUTES = [
  { path: "/", ready: "ACR-INF" },
  {
    path: "/check?unit=%24%2F1k%20tokens&billed_usdc=0.02&quantity=10",
    ready: "ACR-INF",
  },
  { path: "/spend", ready: "Decided\\s+\\d+|Waiting on you|Waiting for you" },
  { path: "/traction", ready: "testnet|mainnet" },
  { path: "/developers", ready: "GET|curl" },
  { path: "/curve", ready: "ACR-INF" },
  { path: "/tape", ready: "\\$" },
  { path: "/ops", ready: "ACR" },
  { path: "/loop", ready: "\\$" },
  { path: "/attack", ready: "bp|USDC" },
  { path: "/companion", ready: "." },
  { path: "/index/ACR-INF", ready: "ACR-INF" },
  /* The float index. `ready` is a PRICE and not prose, for the reason this file
     has already learned twice: plain mode hides expert copy from innerText, so a
     sentence is not a readiness signal. It also needs the treasury's own env
     (ACR_FLOAT_RPC_URL and ACR_FLOAT_VAULT_ADDRESS) to be set on the host being
     measured; without them the page correctly renders "not on this chain" and
     will report as unrendered, which is the truth rather than a fault. */
  { path: "/float", ready: "[0-9]+\\.[0-9]{2}" },
];

const WIDTHS = [375, 640, 900, 1240, 1440];
const EDITIONS = ["expert", "plain"];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = arg("base", "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = arg("out", "measure.md");
const CHAIN = arg("chain", "mainnet");
const ONLY = arg("route", "");
const widths = arg("widths", "").trim()
  ? arg("widths", "").split(",").map(Number)
  : WIDTHS;
const editions = arg("editions", "").trim()
  ? arg("editions", "").split(",")
  : EDITIONS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A minimal CDP client: send {id, method, params}, resolve on the matching id. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 45000);
    });
  }

  /** Evaluate a function in the page and return its value. Args are passed by value. */
  async call(fn, ...args) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || "eval threw");
    }
    return r.result.value;
  }
}

/**
 * The collector. Runs inside the page; must be self-contained (it is stringified).
 * Everything it reports is read off getComputedStyle / getBoundingClientRect, never off
 * the source, because the whole point is to learn which declaration actually won.
 */
function collect() {
  const main = document.querySelector("main") || document.body;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };

  const all = Array.from(main.querySelectorAll("*")).filter(visible);
  const texty = all.filter((e) =>
    Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim()),
  );

  const fs = new Set();
  const lh = new Set();
  const ls = new Set();
  for (const e of texty) {
    const s = getComputedStyle(e);
    fs.add(s.fontSize);
    lh.add(s.lineHeight);
    ls.add(s.letterSpacing);
  }

  const sp = new Set();
  for (const e of all) {
    const s = getComputedStyle(e);
    for (const p of [
      "marginTop",
      "marginBottom",
      "paddingTop",
      "paddingBottom",
      "rowGap",
      "columnGap",
    ]) {
      const v = s[p];
      if (v && v !== "0px" && v !== "normal") sp.add(v);
    }
  }

  // The gold chapter bar is drawn by .section-head::before. Count what RENDERS, not what
  // the markup asks for — that is the number a reader actually sees.
  const heads = Array.from(main.querySelectorAll(".section-head"));
  const bars = heads.filter(
    (h) => getComputedStyle(h, "::before").backgroundImage !== "none",
  ).length;
  const subHeads = main.querySelectorAll(".block-head, .card-head").length;

  /* Overflow, excusing anything inside a deliberate horizontal scroller.

     clientWidth, NOT window.innerWidth. Under Chrome's mobile emulation
     innerWidth is the VISUAL viewport, which includes the page's scale: at a
     375px device it reported 446 and, on a longer page, 524. Measuring
     overflow against that number silently excuses up to 150px of it, which is
     the entire bug class this metric exists to catch, and it made every phone
     row of this census read clean. clientWidth is the layout viewport and is
     375 in every configuration. */
  const vw = document.documentElement.clientWidth;
  const inScroller = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      // `hidden` clips too. Without it, the hero's decorative sun path reports
      // as an overflow on every width, which is a metric crying wolf.
      if (o === "auto" || o === "scroll" || o === "hidden") return true;
    }
    return false;
  };
  const offenders = [];
  for (const e of all) {
    const r = e.getBoundingClientRect();
    if (r.right > vw + 1 && !inScroller(e)) {
      const cls = typeof e.className === "string" ? e.className.split(/\s+/)[0] : "";
      offenders.push(e.tagName.toLowerCase() + (cls ? "." + cls : ""));
    }
  }

  /* Chart left gutters, in rendered px. Every chart here shares a 760-unit
     viewBox at the same CSS width, so one of them drawing at a different x is
     a visible offset between two charts a reader sees side by side.

     THE Y-AXIS, not the first <line> in the SVG. The first line is a gridline
     on some of these charts and the axis on others, so the old version
     reported nine distinct "gutters" for four charts and could never confirm
     or deny the one real misalignment it existed to catch. Each chart draws
     its axis as a VERTICAL line (x1 === x2) at exactly M.left, so the
     leftmost vertical line is the gutter, by construction. */
  const gutters = new Set();
  for (const svg of main.querySelectorAll("svg")) {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const w = svg.getBoundingClientRect().width;
    if (!vb || !vb.width || !w) continue;
    let axis = null;
    for (const line of svg.querySelectorAll("line")) {
      const x1 = parseFloat(line.getAttribute("x1") || "NaN");
      const x2 = parseFloat(line.getAttribute("x2") || "NaN");
      if (!Number.isFinite(x1) || x1 !== x2) continue; // not vertical
      if (axis === null || x1 < axis) axis = x1;
    }
    /* In viewBox UNITS, not rendered px. Every chart here shares the same
       760-unit viewBox at the same CSS width, so the unit is the comparable
       quantity and the pixel value is just that unit times whichever of the
       five widths this row is. Reporting px turned one gutter into five
       numbers and made disagreement impossible to see. */
    if (axis !== null) gutters.add(Math.round(axis));
  }

  // One left edge for every top-level child is what "aligned" means, measurably.
  const edges = new Set(
    Array.from(main.children)
      .filter(visible)
      .map((e) => Math.round(e.getBoundingClientRect().left)),
  );

  const headTree = Array.from(main.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) =>
    h.tagName.toLowerCase(),
  );

  return {
    fs: Array.from(fs).sort((a, b) => parseFloat(a) - parseFloat(b)),
    lh: Array.from(lh),
    ls: Array.from(ls),
    sp: Array.from(sp).sort((a, b) => parseFloat(a) - parseFloat(b)),
    heads: heads.length,
    bars,
    subHeads,
    docOverflow: document.documentElement.scrollWidth - vw,
    offenders: Array.from(new Set(offenders)).slice(0, 6),
    gutters: Array.from(gutters).sort((a, b) => a - b),
    edges: Array.from(edges).sort((a, b) => a - b),
    headTree,
  };
}

/**
 * Wait for the payload, never for a clock. Three conditions, because each one alone has
 * already produced a false pass here: no skeleton left, the route's own data text present,
 * and enough DOM to be the real view rather than a heading and a standfirst.
 *
 * Note innerText shows neither hidden text nor input values, and the dual-edition markup
 * renders BOTH branches with CSS hiding one — so these patterns match expert copy, which
 * is in the DOM either way.
 */
function readyFor(pattern) {
  if (document.querySelector(".skel-line, .skel-card")) return false;
  const txt = (document.body.innerText || "").trim();
  if (txt.length < 800) return false;
  if (!new RegExp(pattern).test(txt)) return false;
  const main = document.querySelector("main") || document.body;
  const rich =
    main.querySelectorAll("table, .panel, .rate-block, .flow-node, .primer-beat").length >= 1;
  return rich;
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "acr-measure-"));
  const port = 9500 + Math.floor(Math.random() * 400);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--disk-cache-size=1",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const rows = [];
  try {
    // Poll for a real page target. tabs[0] is not reliably the page.
    let target = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !target) {
      await sleep(300);
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      } catch {
        /* chrome not up yet */
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

    const host = new URL(BASE).hostname;
    await cdp.send("Network.setCookie", {
      name: CHAIN_COOKIE,
      value: CHAIN,
      domain: host,
      path: "/",
    });

    const routes = ONLY
      ? ROUTES.filter((r) => r.path.startsWith(ONLY)).concat(
          ROUTES.some((r) => r.path.startsWith(ONLY)) ? [] : [{ path: ONLY, ready: "." }],
        )
      : ROUTES;
    for (const edition of editions) {
      for (const { path: route, ready: pattern } of routes) {
        const url =
          BASE + route + (edition === "plain" ? (route.includes("?") ? "&" : "?") + "edition=plain" : "");
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: 1240,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await cdp.send("Page.navigate", { url });

        let ok = false;
        const until = Date.now() + 30000;
        while (Date.now() < until) {
          await sleep(400);
          try {
            if (await cdp.call(readyFor, pattern)) {
              ok = true;
              break;
            }
          } catch {
            /* mid-navigation */
          }
        }

        /* KNOWN LIMIT, so the overflow column is not over-read: each route is
           navigated once at 1240 and then stepped through the widths with
           Emulation alone. Components that measure themselves once (the chart
           SVGs size from a container read on mount) do not recompute, so a
           narrow step can report an overflow that a page LOADED at that width
           does not have. Three rows read 24-42px that way at 375; loading
           /curve, /index and /check directly at 375 gives scrollWidth 375 and
           no offenders. Reload per width if that column ever has to be exact. */
        for (const width of widths) {
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 900,
            deviceScaleFactor: 1,
            mobile: width <= 640,
          });
          await sleep(250); // let the resize settle before reading geometry
          let m = null;
          try {
            m = await cdp.call(collect);
          } catch (e) {
            m = { error: String(e.message || e) };
          }
          rows.push({ route, edition, width, rendered: ok, ...m });
          process.stderr.write(
            `  ${edition.padEnd(6)} ${String(width).padStart(4)}  ${route}${ok ? "" : "  [NOT RENDERED]"}\n`,
          );
        }
      }
    }
  } finally {
    chrome.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const n = (a) => (Array.isArray(a) ? a.length : "");
  let md = `# UI census · ${BASE} · chain ${CHAIN}\n\n`;
  md += `Generated ${new Date().toISOString()}\n\n`;
  md += `| route | ed | w | sizes | spacing | lh | tr | heads | bars | sub | overflow | gutters | edges | headings |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    const over =
      r.docOverflow > 0 || (r.offenders && r.offenders.length)
        ? `**${r.docOverflow}px** ${(r.offenders || []).join(" ")}`.trim()
        : "0";
    md += `| ${r.route} | ${r.edition[0]} | ${r.width} | ${n(r.fs)} | ${n(r.sp)} | ${n(r.lh)} | ${n(r.ls)} | ${r.heads ?? ""} | ${r.bars ?? ""} | ${r.subHeads ?? ""} | ${over} | ${(r.gutters || []).join(",")} | ${n(r.edges)} | ${(r.headTree || []).join("")} |\n`;
  }

  const union = (k) => {
    const s = new Set();
    for (const r of rows) for (const v of r[k] || []) s.add(v);
    return Array.from(s);
  };
  const fsAll = union("fs").sort((a, b) => parseFloat(a) - parseFloat(b));
  const spAll = union("sp").sort((a, b) => parseFloat(a) - parseFloat(b));
  md += `\n## App-wide totals\n\n`;
  md += `- distinct computed **font sizes**: **${fsAll.length}** · ${fsAll.join(" ")}\n`;
  md += `- distinct computed **spacing values**: **${spAll.length}** · ${spAll.join(" ")}\n`;
  md += `- distinct **line-heights**: **${union("lh").length}** · ${union("lh").join(" ")}\n`;
  md += `- distinct **letter-spacings**: **${union("ls").length}** · ${union("ls").join(" ")}\n`;
  md += `- distinct **chart gutters**: ${union("gutters").join(", ")}\n`;
  md += `- **gold bars** rendered, worst page: ${Math.max(0, ...rows.map((r) => r.bars || 0))}\n`;
  md += `- rows with horizontal **overflow**: ${rows.filter((r) => r.docOverflow > 0 || (r.offenders || []).length).length} of ${rows.length}\n`;
  md += `- rows that never **rendered**: ${rows.filter((r) => !r.rendered).length} of ${rows.length}\n`;

  await writeFile(OUT, md);
  await writeFile(OUT.replace(/\.md$/, "") + ".json", JSON.stringify(rows, null, 1));
  process.stderr.write(`\nwrote ${OUT}\n`);
}

main().catch((e) => {
  process.stderr.write(`measure-ui failed: ${e.stack || e}\n`);
  process.exit(1);
});
