import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BANNED_WORDS, hasEmDash, hasFigure, jargonIn, printable } from "./narrate";

const HERE = dirname(fileURLToPath(import.meta.url));

test("a figure in the prose drops the whole answer, never just the figure", () => {
  /* THE ONE THAT MATTERS. Every number on this surface is read off the chain.
     A model that invents one has produced an unsourced figure, and a sentence
     with its numbers cut out is no longer the sentence that was checked. */
  const r = printable("The treasury paid 1.0553 USDC to the seller.");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.why, /figure/);
  assert.ok(hasFigure("paid 1 unit"));
  assert.ok(hasFigure("in 2026"));
  assert.ok(!hasFigure("the treasury paid the seller and a receipt was written"));
});

test("an empty or whitespace answer is nothing, not a short answer", () => {
  for (const bad of ["", "   ", "\n\t ", undefined, null]) {
    const r = printable(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test("the em dash is refused, because the house separator replaced it", () => {
  assert.ok(hasEmDash("the agent asked — and held nothing"));
  assert.equal(printable("the agent asked — and held nothing").ok, false);
  // the EN dash survives for ranges and names, as the gate's own comment says
  assert.ok(!hasEmDash("one to four – four"));
});

test("jargon the plain edition bans is refused in a model's sentence too", () => {
  assert.deepEqual(jargonIn("the attestation proved it"), ["attestation"]);
  assert.deepEqual(jargonIn("a nanopayment over x402").sort(), ["nanopayment", "x402"]);
  assert.equal(jargonIn("the treasury paid the seller").length, 0);
  const r = printable("The provenance of the payment was checked.");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.why, /jargon/);
});

test("a clean two-sentence answer passes, and comes back trimmed", () => {
  const good =
    "  An automated program asked to buy computing power, and its own wallet stayed empty. " +
    "The treasury checked the asking price against a reference price before it paid.  ";
  const r = printable(good);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.text, good.trim());
});

test("the banned list cannot drift from the gate's own list", () => {
  /* `coverage.test.ts` lints only STATIC `p="…"` props, so a model's sentence
     escapes it entirely. This file re-applies the same vocabulary, and the two
     copies would otherwise rot apart in opposite directions. Read the gate's
     regex and prove every term it bans is covered here. */
  const gate = readFileSync(join(HERE, "coverage.test.ts"), "utf8");
  const m = gate.match(/const BANNED_IN_PLAIN\s*=\s*\n?\s*\/\\b\(([^)]+)\)/);
  assert.ok(m, "could not find BANNED_IN_PLAIN in coverage.test.ts");
  const terms = m[1].split("|");
  assert.ok(terms.length > 15, `expected the real list, got ${terms.length}`);

  const missing: string[] = [];
  for (const raw of terms) {
    /* The gate's regex carries optionality (`EIP-?712`) and suffixes
       (`deconvolv\w*`); reduce each to a literal this list must contain. */
    const literal = raw.replace(/\\w\*/g, "").replace(/-\?/g, "-").replace(/\\b/g, "");
    const hit = BANNED_WORDS.some(
      (w) => w.toLowerCase() === literal.toLowerCase() || literal.toLowerCase().startsWith(w.toLowerCase()),
    );
    if (!hit) missing.push(literal);
  }
  assert.deepEqual(missing, [], `terms the gate bans and this file would let a model say: ${missing.join(", ")}`);
});
