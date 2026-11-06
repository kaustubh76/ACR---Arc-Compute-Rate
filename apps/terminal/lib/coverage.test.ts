import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAIN_GLOSSARY, PRIMER_BEATS } from "./plainGlossary";

/* The whole-project gate of the Plain Edition.

   Guarantee under test: no expert jargon is reachable in plain mode, on any
   surface, now or in any future PR. Two mechanisms:

   1. A ledger: every .tsx under app/ and components/ must appear in exactly
      one of REQUIRED_COVERAGE (with a minimum count of edition markers —
      <Ed …>, <Term …>, useEdition()) or EXEMPT (with a reason). A new file
      in neither list fails, so future features must ship plain variants —
      or an explicit exemption — to pass CI.

   2. A banned-jargon lint over the statically extractable plain copy
      (p="…" string props, glossary glosses, primer beats). JSX-fragment
      plain branches are covered by mechanism 1 plus the release walkthrough. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** repo-relative path → minimum number of edition markers (floor, not exact).
 *
 *  RAISED TO ACTUAL 2026-10-10 for nine entries whose floor had stopped
 *  holding anything — several sat at less than half the real count, so a
 *  surface could lose twenty markers and still pass. That is the state the
 *  comments below already call out by name on two other files; it had simply
 *  happened again, including on two I edited this week and did not re-measure.
 *  A floor well under actual is a floor that cannot fail. */
const REQUIRED_COVERAGE: Record<string, number> = {
  "app/view.tsx": 2, // hero copy lives in HomeHero; the primer mount is plain-only by CSS
  // Raised from 12 against an actual 32 — twenty markers of slack, the state
  // the sellers/developers comments below call a floor that stopped holding.
  "app/index/[id]/view.tsx": 32,
  "app/attack/view.tsx": 29,
  "app/curve/view.tsx": 16, // 5 -> 16: measured, plus the shop-floor disclosure
  // The tape: every figure is a measurement of how well an agent traded, so
  // both editions carry the whole page rather than the expert one plus labels.
  // 40 -> 43: the grade-me field, the no-fills branch and the people column.
  "app/tape/view.tsx": 66, // the Sells column, seller names, the slippage titles, and the People column
  // This carried a floor well under its actual count, which is the state the
  // comment below describes as a floor that has stopped holding anything.
  // Raised to actual as part of the register extraction.
  "app/developers/view.tsx": 80, // incl. the human gate section and the two operator rows
  "app/error.tsx": 3,
  "app/not-found.tsx": 3,
  "components/Masthead.tsx": 6,
  // 9 still, but no longer "incl. the network chip": that one was removed
  // as a repeat of the masthead's MAINNET | TESTNET control. The file sits
  // exactly on its floor now.
  "components/ChainStrip.tsx": 9, // incl. the verified-humans and stale-resolution chips
  "components/Colophon.tsx": 13, // incl. the identity line and the salt-mismatch warning
  "components/HomeHero.tsx": 5,
  "components/RateBlock.tsx": 4,
  "components/PrintsTable.tsx": 6,
  "components/DefensibilityStrip.tsx": 3,
  "components/FuturesTeaser.tsx": 3,
  "components/TapeTeaser.tsx": 3,
  "components/loop/LoopFlow.tsx": 32,
  "components/loop/Wake.tsx": 1,
  "components/loop/TierColumns.tsx": 8,
  "components/loop/ScreenLab.tsx": 46,
  "components/loop/PersonNotWallet.tsx": 43,
  "app/loop/view.tsx": 4,
  "components/WorkloadRow.tsx": 8, // the editor: trigger, three field labels, done, privacy line
  "components/EmbedRow.tsx": 8, // the embed row: trigger, three forms, copy/copied, the live line, done
  "components/WorkloadChip.tsx": 1, // one label; the figure itself is a number, outside <Ed>
  "components/WalletFunding.tsx": 6, // the balance line, deposit, bridge (busy + idle) and the bridge note
  // The §5.9 read gate. Both editions carry the whole refusal, because a
  // reader who cannot open a page needs the way past it in words they read.
  // One apology, three surfaces. /spend, /traction and /check each had their
  // own outage sentence and none could tell "this press is down" from "this
  // press predates the route"; the markers that left those files landed here.
  "components/WhyEmpty.tsx": 4,
  "components/spend/ReaderCardGate.tsx": 12,
  "components/spend/LedgerDownload.tsx": 4, // the label plus its three phases

  "components/chain/PublicDesk.tsx": 39, // incl. the withdraw/exit copy
  "components/chain/AttackTape.tsx": 10, // the estimator log speaks in both editions
  "components/chain/DeskSteps.tsx": 3, // the five step names + the wait line
  // This sat at 10 against an actual 13 — three markers of slack, which is a
  // floor holding nothing. (The comment this used to point at belonged to
  // app/sellers/view.tsx and went with that page.) Raised to actual; the
  // ledger's is now 23 because every section title speaks in both editions.
  "app/ops/view.tsx": 23, // the ledger reads for operators AND for readers
  // The owner's page speaks to an owner, not an operator: every heading, every
  // outcome chip and the savings caveat all carry both registers.
  // Measured with THIS file's own regex, which counts `<Ed>` and `<Ed\n` as
  // well as `<Ed ` — an eyeball grep for `<Ed ` undercounts by a third and is
  // how two of these floors were briefly set below actual.
  "app/spend/view.tsx": 97, // the queue (even empty), the budgets, which chain, the six errors, and the price-check link per escalation
  "app/traction/view.tsx": 49, // every figure labelled in both registers
  // The form, the three unit hints, the verdict rows, the basket state and
  // every column of the comparison table. A visitor who cannot read "$/1k
  // tokens" is exactly the visitor this page is for.
  // Raised 40 -> 48 on 2026-10-12, to ACTUAL, for the reason the ops/view.tsx
  // note above gives: eight markers of slack is a floor holding nothing. The
  // basket's age and the sentence that says what to do about it are two of
  // those eight, and they are exactly the sort of copy that gets dropped in a
  // refactor without any gate noticing.
  "app/check/view.tsx": 48,
  // two sides, two registers each: mainnet | testnet, one <Ed> per button.
  "components/ChainToggle.tsx": 2,
  "components/spend/EscalationActions.tsx": 11, // the key, the buttons, why they are off without one, the note, who signs
  "components/chain/OperatorConsole.tsx": 13, // the locked + unlocked states both speak
  "components/chain/HedgerPanel.tsx": 36, // incl. the two-addresses-one-agent copy
  "components/ApiConsole.tsx": 24,
  "components/WebhookActivity.tsx": 4,
  "components/chain/ChainFactsStrip.tsx": 3,
  "components/chain/ContractRegister.tsx": 10, // seven glosses, the custody note, the sim tape line
  // The chain-read proof, re-homed off /sellers when that page went: the
  // button, its explanation, and the two labels on the result.
  "components/chain/RegistryProof.tsx": 4,
  "components/chain/OracleProvenance.tsx": 5,
  "components/chain/FinalityBadge.tsx": 3,
  "components/chain/WalletPanel.tsx": 4,
  "components/chain/FuturesDesk.tsx": 27, // incl. the per-series contract-size panel
  "components/chain/FuturesTape.tsx": 3, // incl. the "you" chip on a reader's own fill
  // The 401 challenge, shown the way ApiConsole shows the 402: every label
  // dual-renders, and the "what would answer this" line has three backends.
  "components/chain/HumanProof.tsx": 32,
  "components/chain/AgentCardSnippet.tsx": 12,
  // The hosted-MCP playground: URL, inputs, live runs and per-client setup.
  "components/chain/McpSnippet.tsx": 27,
  // The shop floor, folded in from the old /exchange route. Rendered only when
  // its disclosure is open, so a reader of /curve does not pay for its tickers.
  "components/chain/ShopFloor.tsx": 42,
  "components/chain/SettlementTape.tsx": 3,
  "components/chain/PaymentToast.tsx": 1,
  "components/chain/FillToast.tsx": 1,
  "app/float/approve/view.tsx": 22, // the three honest states, the code, the countdown, and every label on the card
  // The float index. Measured, not estimated: the gate's own note above is that
  // a floor under actual is a floor that cannot fail, and these four landed
  // together so there is no excuse for carrying slack in any of them.
  "app/float/view.tsx": 25, // four honest states, the hero, the money path's caption and the three doors
  "components/float/Ladder.tsx": 38, // twelve rung names in both registers, the controls, the presets and the fork
  "components/float/VaultMeter.tsx": 8, // three sleeve labels, the total, and the banner for a sleeve that is not live
  "components/float/MoneyPath.tsx": 3, // the diagram's nouns are register-neutral by necessity; the caption carries it
  "app/float/join/view.tsx": 27, // measured: the eight named refusals each get their own sentence, plus the form and the issued card
  "components/chain/TxLink.tsx": 2,
  "components/chain/Badges.tsx": 2,
  "components/charts/AttackChart.tsx": 2,
  "components/charts/HistoryChart.tsx": 1,
  "components/charts/QuoteCorridor.tsx": 1,
  "components/charts/FuturesMarkChart.tsx": 4, // legend, empty state, aria-label
};

/** Files that deliberately carry no edition markers — each with its reason. */
const EXEMPT: Record<string, string> = {
  "app/layout.tsx": "shell only — visible copy lives in Masthead/ChainStrip/Colophon",
  "app/template.tsx": "enter-animation wrapper, no copy",
  "app/global-error.tsx": "replaces the root layout, so the edition boot script never runs",
  "app/loading.tsx": "skeleton vocabulary is edition-neutral by design",
  "app/attack/loading.tsx": "skeleton",
  "app/curve/loading.tsx": "skeleton",
  "app/tape/loading.tsx": "skeleton",
  "app/tape/page.tsx": "metadata only — the client hook owns the tape, like /ops",
  "app/developers/loading.tsx": "skeleton",
  "app/ops/loading.tsx": "skeleton",
  "app/spend/loading.tsx": "skeleton",
  "app/traction/loading.tsx": "skeleton",
  "app/index/[id]/loading.tsx": "skeleton",
  "app/page.tsx": "metadata only — SEO stays expert",
  "app/attack/page.tsx": "metadata only",
  "app/loop/page.tsx": "metadata only",
  "app/loop/loading.tsx": "skeleton",
  "app/curve/page.tsx": "metadata only",
  "app/developers/page.tsx": "metadata only",
  "app/ops/page.tsx": "metadata only",
  "app/float/approve/page.tsx": "metadata only — the client hook owns the queue, like /ops",
  "app/float/approve/loading.tsx": "skeleton",
  "app/float/join/page.tsx": "metadata only — the client component owns the whole sequence, like /float/approve",
  "app/float/page.tsx": "metadata only — the client hooks own every number, like /float/approve",
  "app/float/loading.tsx": "skeleton",
  "app/float/join/loading.tsx": "skeleton",
  "app/spend/page.tsx": "metadata only — the client hook owns the queue, like /ops",
  "app/traction/page.tsx": "metadata only — the client hook owns the count, like /ops",
  "app/check/page.tsx": "metadata only — a price check has no answer until a visitor types one",
  "app/og/home/route.tsx": "a preview image has one edition, the expert one; it is a picture, not a page",
  "app/og/check/route.tsx": "a preview image has one edition, the expert one; it is a picture, not a page",
  "app/index/[id]/page.tsx": "metadata only",
  "app/companion/page.tsx": "the reader's companion IS the plain voice — one register",
  "components/AgentDrawer.tsx": "plain-language chat shell in both editions",
  "components/AgentChat.tsx": "third-party Aomi widget, no host-authored copy",
  "components/Ed.tsx": "edition machinery",
  "components/Term.tsx": "edition machinery",
  "components/EditionToggle.tsx": "edition machinery",
  "components/PlainPrimer.tsx": "plain-only content by construction",
  "components/ArcHorizon.tsx": "SVG art, no copy",
  "components/TickerNumber.tsx": "numerals only",
  "components/ThemeRoom.tsx": "renders nothing",
  "components/chain/AddressChip.tsx": "titles are addresses; words already plain",
  "components/charts/GlowPath.tsx": "stroke primitive, no copy",
  "components/charts/Sparkline.tsx": "no text",
};

/** Terms that must never appear un-glossed in plain copy. */
const BANNED_IN_PLAIN =
  /\b(VWAP|EIP-?712|EIP-?3009|x402|sybil|hedonic|deconvolv\w*|attestation|provenance|settlement-grade|SLO|Louvain|Kalman|CAIP|standfirst|colophon|Malachite|BFT|nanopayment|ACROracle|estimand|tenor)\b/i;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const ALL = [...tsxFiles(join(ROOT, "app")), ...tsxFiles(join(ROOT, "components"))].map((f) =>
  relative(ROOT, f),
);

/* Structural elements this stylesheet only reaches through a class. There is
   no bare `table`, `ul`, `ol` or `dl` element selector in globals.css — every
   table rule is scoped to `table.sheet` — so one of these without a className
   renders on UA defaults: ~1px cell padding, no row rules, disc bullets, a
   40px inset nobody chose. Eleven tables and one list shipped that way on
   /spend and /traction and passed typecheck, lint, build and this whole file. */
const STRUCTURAL = ["table", "ul", "ol", "dl"] as const;

/** Class tokens this file can prove are intended, from one .tsx source.
 *
 *  Deliberately narrow: `className="a b"` literals, and the STATIC text of a
 *  `className={`a ${x}`}` template. It does NOT read strings nested inside
 *  `${…}`, because they are not all class names — `phase === "error" ? …` in
 *  EscalationActions.tsx would be read as a class called `error`, and a gate
 *  that cries wolf gets deleted. A runtime-computed class is out of reach of
 *  any source scan; that is the limit, and it is written down rather than
 *  papered over. */
function classTokens(src: string): string[] {
  const out: string[] = [];
  const push = (blob: string) => {
    for (const t of blob.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
      if (/^[A-Za-z_][\w-]*$/.test(t)) out.push(t);
    }
  };
  for (const m of src.matchAll(/className="([^"]*)"/g)) push(m[1]);
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) push(m[1]);
  return out;
}

test("ledger: every surface is covered or exempt, classed, and its classes exist", () => {
  const unlisted = ALL.filter((f) => !(f in REQUIRED_COVERAGE) && !(f in EXEMPT));
  assert.deepEqual(
    unlisted,
    [],
    `new .tsx files must ship plain variants (add to REQUIRED_COVERAGE) or an explicit exemption: ${unlisted.join(", ")}`,
  );
  // The inverse: a ledger entry pointing at a deleted/renamed file is stale.
  const gone = [...Object.keys(REQUIRED_COVERAGE), ...Object.keys(EXEMPT)].filter(
    (f) => !ALL.includes(f),
  );
  assert.deepEqual(gone, [], `ledger entries with no file: ${gone.join(", ")}`);

  /* A surface is not accounted for just because it is listed. Nothing in this
     repo read `className` until now, which is how `table`, `teal`,
     `wallet-panel`, `.is-on` and `primer` each shipped green. Two halves: an
     element that cannot be styled without a class must carry one, and a class
     that is carried must exist. */
  const bare: string[] = [];
  const dangling: string[] = [];
  const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
  /* A letter or underscore after the dot, so `0.14` in an rgba() and `13.5px`
     in a font-size are not read as selectors. Prose in a comment ("see
     td.wrap") lands in here too, which only ever makes this half MORE
     permissive — it can never invent a failure. */
  const defined = new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));

  for (const file of ALL) {
    const src = readFileSync(join(ROOT, file), "utf8");
    for (const el of STRUCTURAL) {
      for (const m of src.matchAll(new RegExp(`<${el}(\\s[^>]*)?>`, "g"))) {
        if ((m[1] ?? "").includes("className")) continue;
        bare.push(`${file}:${src.slice(0, m.index).split("\n").length} <${el}>`);
      }
    }
    for (const tok of classTokens(src)) {
      if (!defined.has(tok)) dangling.push(`${file}: .${tok}`);
    }
  }
  assert.deepEqual(
    bare,
    [],
    `a <table>/<ul>/<ol>/<dl> with no className renders on browser defaults: ${bare.join(", ")}`,
  );
  assert.deepEqual(
    dangling,
    [],
    `className with no rule in globals.css: ${dangling.join(", ")}`,
  );

  /* Third half, and the one that keeps the scales from eroding. The app had
     ~400 inline style objects, 315 of them fully static, setting type and
     rhythm from JSX where no stylesheet could govern them: 136 fontSize props
     and 140 marginTop props between them, which is why the rendered page
     measured 38 distinct font sizes against a stylesheet holding 8.

     So this does not ban inline styles. A computed width, a per-datum colour
     and an SVG geometry all belong inline and no class can express them. It
     bans an OFF-SCALE NUMBER: a bare numeric literal on a type or spacing
     property, which is a value chosen by hand instead of taken from :root.
     `var(--t-4)` passes, a string passes, any expression passes, and 0 passes
     because zero needs no token. */
  const SCALED = [
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "marginTop",
    "marginBottom",
    "marginLeft",
    "marginRight",
    "gap",
    "rowGap",
    "columnGap",
    "paddingTop",
    "paddingBottom",
    "paddingLeft",
    "paddingRight",
    "margin",
    "padding",
  ];
  /* app/global-error.tsx replaces the root layout when it fires, so by its own
     comment it can assume nothing from globals.css — a var() there resolves to
     nothing. Its literals are correct and must stay. */
  const SCALE_EXEMPT = new Set(["app/global-error.tsx"]);
  /* The og/ routes are not the website. They render a PNG through Satori, which
     has no cascade and no custom properties: `var(--t-4)` there resolves to
     nothing and the text disappears from the image. Their numbers are the
     image's own geometry and belong as literals. */
  const scaleExempt = (f: string) => SCALE_EXEMPT.has(f) || f.startsWith("app/og/");
  const offScale: string[] = [];
  const propRe = new RegExp(`\\b(${SCALED.join("|")}):\\s*([^,}]+)`, "g");
  /* The text of every `style=` prop, read by balancing braces rather than by
     matching the literal `style={{`.

     This cost something to learn. The first version of this gate matched
     `style={{` only, so it could not see a style object behind a conditional,
     and `style={micro ? { fontSize: 9.5 } : undefined}` in FinalityBadge sat
     inside the blind spot while the rendered census reported three chips at a
     size that appeared in neither this stylesheet nor any inline style. A gate
     that cannot see a shape is not a gate against that shape.

     Brace-balanced means a computed value still passes: /tape's two
     `style={slipStyle(...)}` calls contain no bare number on a scaled property
     and are meant to keep working. */
  const styleProps = (src: string): string[] => {
    const out: string[] = [];
    for (let i = src.indexOf("style={"); i !== -1; i = src.indexOf("style={", i + 1)) {
      let depth = 0;
      for (let j = i + 6; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) {
          out.push(src.slice(i + 7, j));
          break;
        }
      }
    }
    return out;
  };
  for (const file of ALL) {
    if (scaleExempt(file)) continue;
    const src = readFileSync(join(ROOT, file), "utf8");
    for (const body of styleProps(src)) {
      for (const m of body.matchAll(propRe)) {
        const v = m[2].trim();
        if (/^-?\d+(\.\d+)?$/.test(v) && v !== "0") {
          offScale.push(`${file}: ${m[1]}: ${v}`);
        }
      }
    }
  }
  assert.deepEqual(
    offScale,
    [],
    `inline style sets a type or spacing value by hand instead of from the scale (use var(--t-N) / var(--s-N)): ${offScale.join(", ")}`,
  );

  /* Fourth half: two couplings that are invisible from either side alone, and
     both of which would read as working code while silently deleting the
     feature they look like they implement.

     `.sr-only` must refuse selection. TickerNumber renders an aural copy of
     every rolling numeral beside the digits — without it, a reader copying a
     rate off a card gets the number twice ("0.492360.49236"), and an /ops
     table carries its hidden column headers into the clipboard.

     `.skip-link` must not hide itself with `display` or `visibility`, because
     neither can hold focus: a skip link written that way renders, reads fine
     in review, and does nothing at all. It must also be declared BEFORE
     `.ed-p`, whose `display: none` is a single-class rule that any later
     single-class `display` rule overrides app-wide, rendering both editions.

     Read from the rule BODY with comments stripped, because both rules explain
     themselves in prose that contains the very declarations under test. */
  const ruleBody = (sel: string): string => {
    const at = css.indexOf(`\n${sel} {`);
    assert.ok(at >= 0, `${sel} rule missing from globals.css`);
    return css.slice(at, css.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
  };
  assert.match(
    ruleBody(".sr-only"),
    /[^-]user-select:\s*none/,
    ".sr-only must set user-select: none, or text meant only to be read aloud lands in a sighted reader's clipboard",
  );
  assert.doesNotMatch(
    ruleBody(".skip-link"),
    /(^|[\s;])(display|visibility)\s*:/,
    ".skip-link must stay focusable: park it by offset, never display/visibility",
  );
  assert.ok(
    css.indexOf("\n.skip-link {") < css.indexOf("\n.ed-p {"),
    ".skip-link must be declared before .ed-p, or a later single-class display rule unhides the plain edition app-wide",
  );
});

test("floors: every covered surface meets its minimum marker count", () => {
  const short: string[] = [];
  for (const [file, min] of Object.entries(REQUIRED_COVERAGE)) {
    const src = readFileSync(join(ROOT, file), "utf8");
    const n = (src.match(/<Ed[\s/>]|<Term[\s>]|useEdition\(/g) ?? []).length;
    if (n < min) short.push(`${file}: ${n} < ${min}`);
  }
  assert.deepEqual(short, []);
});

test("banned jargon never leaks into extractable plain copy", () => {
  const leaks: string[] = [];
  for (const file of ALL) {
    const src = readFileSync(join(ROOT, file), "utf8");
    // p="…" string props are pure plain copy with no <Term> escape possible.
    for (const m of src.matchAll(/\bp="([^"]+)"/g)) {
      if (BANNED_IN_PLAIN.test(m[1])) leaks.push(`${file}: p="${m[1].slice(0, 60)}…"`);
    }
  }
  for (const [key, { gloss }] of Object.entries(PLAIN_GLOSSARY)) {
    // Term display names may TEACH a term ("plain average (VWAP)") — glosses may not lean on one.
    if (BANNED_IN_PLAIN.test(gloss)) leaks.push(`glossary gloss ${key}: ${gloss}`);
  }
  for (const beat of PRIMER_BEATS) {
    if (BANNED_IN_PLAIN.test(beat.head) || BANNED_IN_PLAIN.test(beat.body))
      leaks.push(`primer beat: ${beat.head}`);
  }
  assert.deepEqual(leaks, []);
});

/* Both editions' copy is swept clean of the em dash, and stays that way.
   Not a style preference: a dash was doing four different jobs here — missing
   value, label/value separator, chart legend swatch, and mid-sentence pause —
   and a mark that means four things reads as filler in all four. The house
   separator is the middot (·), a missing number is an ellipsis, a legend key
   is a real swatch, and a sentence that wants a pause gets a second sentence.
   The en dash survives for genuine ranges (1–4 ms) and names
   (Avellaneda–Stoikov), which is why this tests for — alone. */
const COPY_PROPS = /\b[xp]="([^"]+)"/g;

test("no em dash in either edition's copy", () => {
  const dashed: string[] = [];
  for (const file of ALL) {
    const src = readFileSync(join(ROOT, file), "utf8");
    for (const m of src.matchAll(COPY_PROPS)) {
      if (m[1].includes("—")) dashed.push(`${file}: ${m[0].slice(0, 72)}…`);
    }
  }
  for (const [key, { gloss }] of Object.entries(PLAIN_GLOSSARY)) {
    if (gloss.includes("—")) dashed.push(`glossary gloss ${key}`);
  }
  for (const beat of PRIMER_BEATS) {
    if (beat.head.includes("—") || beat.body.includes("—")) dashed.push(`primer beat: ${beat.head}`);
  }
  assert.deepEqual(dashed, []);
});

/* Plain copy is a one-liner or it is not plain copy. The whole point of the
   edition is that a first-time reader gets the thing in one pass; a 299-char
   three-sentence paragraph is the expert edition wearing simpler words. 140 is
   the same ceiling the glossary already holds itself to (lib/glossary.test.ts). */
const PLAIN_MAX = 140;

test("plain copy stays a one-liner", () => {
  const long: string[] = [];
  for (const file of ALL) {
    const src = readFileSync(join(ROOT, file), "utf8");
    for (const m of src.matchAll(/\bp="([^"]+)"/g)) {
      if (m[1].length > PLAIN_MAX) long.push(`${file}: ${m[1].length} chars — ${m[1].slice(0, 48)}…`);
    }
  }
  assert.deepEqual(long, []);
});
