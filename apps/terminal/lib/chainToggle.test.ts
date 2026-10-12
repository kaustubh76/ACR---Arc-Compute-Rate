import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* The network switch's contract with the stylesheet.

   WHY THIS FILE EXISTS. Nothing in this repo checks that a className a
   component renders has a rule behind it, and that gap has already shipped
   dangling classes more than once (`table`, `teal`, `wallet-panel`). For this
   control the gap is worse than cosmetic: WHICH SIDE IS LIT is decided entirely
   in CSS, keyed on `<html data-chain>`, so a renamed class or a deleted override
   leaves a toggle that switches perfectly and shows the wrong network as
   current. Every unit test elsewhere would still pass.

   Read as text rather than rendered, for the reason `coverage.test.ts` gives:
   `node --test` has no DOM, and the property under test is the pairing of two
   files, not the behaviour of either one. */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const component = readFileSync(join(ROOT, "components", "ChainToggle.tsx"), "utf8");
const masthead = readFileSync(join(ROOT, "components", "Masthead.tsx"), "utf8");
// Comments stripped: a class merely MENTIONED in a comment is not a class with a rule.
const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every class name in a component's string-literal `className`s. */
function classesIn(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/className="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  }
  return [...out];
}

/** Whether the stylesheet has a selector that names this class. */
function hasRule(cls: string): boolean {
  return new RegExp(`\\.${cls.replace(/-/g, "\\-")}(?![\\w-])[^{]*\\{`).test(css);
}

test("every class the network switch renders has a rule behind it", () => {
  const classes = classesIn(component);
  assert.ok(classes.length >= 4, `expected the segmented classes, found ${JSON.stringify(classes)}`);
  const dangling = classes.filter((c) => !hasRule(c));
  assert.deepEqual(dangling, [], `ChainToggle renders classes globals.css never styles: ${dangling}`);
});

test("the lit side is decided by the server-rendered data-chain, both ways", () => {
  /* The default (mainnet) lights `on-main` with no attribute selector, and
     testnet must both UNLIGHT it and LIGHT `on-test`. Losing either override
     gives a control with two sides lit, or none, on the sandbox — the one
     network where showing the wrong state matters most. */
  assert.match(css, /\.chain-seg button\.on-main\s*\{[^}]*background:\s*var\(--protocol\)/);
  assert.match(css, /\[data-chain="testnet"\]\s*\.chain-seg button\.on-main\s*\{[^}]*background:\s*transparent/);
  assert.match(css, /\[data-chain="testnet"\]\s*\.chain-seg button\.on-test\s*\{[^}]*background:\s*var\(--gold-wash\)/);
});

test("the old asymmetric switch left nothing behind", () => {
  /* Its classes are gone from the component; a rule left in the stylesheet for
     them would be dead weight that reads as if something still used it. */
  for (const old of ["chain-switch", "chain-on-default", "chain-off-default"]) {
    assert.ok(!component.includes(old), `ChainToggle still renders ${old}`);
    assert.ok(!hasRule(old), `globals.css still styles the retired .${old}`);
  }
});

test("both masthead toggles announce which side is current", () => {
  /* A segmented control whose lit side is only a colour is invisible to a
     screen reader. EXPERT | PLAIN carried aria-pressed from the start; the
     network switch did not, which was half of why it read as inert. */
  for (const [name, src] of [
    ["ChainToggle", component],
    ["EditionToggle", readFileSync(join(ROOT, "components", "EditionToggle.tsx"), "utf8")],
  ] as const) {
    const buttons = src.match(/<button\b[\s\S]*?>/g) ?? [];
    assert.equal(buttons.length, 2, `${name} should render exactly two buttons`);
    for (const b of buttons) assert.match(b, /aria-pressed=/, `${name} has a button without aria-pressed`);
  }
  // And the masthead hands the switch this request's chain, so aria-pressed is
  // right on the first paint rather than only after hydration.
  assert.match(masthead, /<ChainToggle\s+chain=\{initial\.chain\}\s*\/>/);
});
