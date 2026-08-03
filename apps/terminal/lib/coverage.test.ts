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

/** repo-relative path → minimum number of edition markers (floor, not exact). */
const REQUIRED_COVERAGE: Record<string, number> = {
  "app/view.tsx": 2, // hero copy lives in HomeHero; the primer mount is plain-only by CSS
  "app/index/[id]/view.tsx": 12,
  "app/attack/view.tsx": 10,
  "app/curve/view.tsx": 5,
  "app/exchange/view.tsx": 12,
  "app/sellers/view.tsx": 8,
  "app/developers/view.tsx": 8,
  "app/error.tsx": 3,
  "app/not-found.tsx": 3,
  "components/Masthead.tsx": 6,
  "components/ChainStrip.tsx": 5,
  "components/Colophon.tsx": 3,
  "components/HomeHero.tsx": 5,
  "components/RateBlock.tsx": 4,
  "components/PrintsTable.tsx": 6,
  "components/DefensibilityStrip.tsx": 3,
  "components/FuturesTeaser.tsx": 3,
  "components/chain/PublicDesk.tsx": 14, // incl. the withdraw/exit copy
  "components/chain/HedgerPanel.tsx": 14, // incl. the two-addresses-one-agent copy
  "components/ApiConsole.tsx": 8,
  "components/WebhookActivity.tsx": 4,
  "components/chain/ChainFactsStrip.tsx": 3,
  "components/chain/OracleProvenance.tsx": 5,
  "components/chain/FinalityBadge.tsx": 3,
  "components/chain/WalletPanel.tsx": 4,
  "components/chain/FuturesDesk.tsx": 8,
  "components/chain/FuturesTape.tsx": 2,
  "components/chain/SettlementTape.tsx": 3,
  "components/chain/PaymentToast.tsx": 1,
  "components/chain/TxLink.tsx": 2,
  "components/chain/Badges.tsx": 2,
  "components/charts/AttackChart.tsx": 2,
  "components/charts/HistoryChart.tsx": 1,
  "components/charts/QuoteCorridor.tsx": 1,
};

/** Files that deliberately carry no edition markers — each with its reason. */
const EXEMPT: Record<string, string> = {
  "app/layout.tsx": "shell only — visible copy lives in Masthead/ChainStrip/Colophon",
  "app/template.tsx": "enter-animation wrapper, no copy",
  "app/global-error.tsx": "replaces the root layout, so the edition boot script never runs",
  "app/loading.tsx": "skeleton vocabulary is edition-neutral by design",
  "app/attack/loading.tsx": "skeleton",
  "app/curve/loading.tsx": "skeleton",
  "app/exchange/loading.tsx": "skeleton",
  "app/sellers/loading.tsx": "skeleton",
  "app/developers/loading.tsx": "skeleton",
  "app/index/[id]/loading.tsx": "skeleton",
  "app/page.tsx": "metadata only — SEO stays expert",
  "app/attack/page.tsx": "metadata only",
  "app/curve/page.tsx": "metadata only",
  "app/exchange/page.tsx": "metadata only",
  "app/sellers/page.tsx": "metadata only",
  "app/developers/page.tsx": "metadata only",
  "app/index/[id]/page.tsx": "metadata only",
  "app/companion/page.tsx": "the reader's companion IS the plain voice — one register",
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

test("ledger: every surface is either covered or exempt (with a reason)", () => {
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
