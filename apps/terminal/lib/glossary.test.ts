import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GLOSSARY_THEMES, PLAIN_GLOSSARY, PRIMER_BEATS } from "./plainGlossary";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

const SOURCES = [...tsxFiles(join(ROOT, "app")), ...tsxFiles(join(ROOT, "components"))];

test("every <Term k> in the codebase exists in the glossary", () => {
  // Belt-and-braces over the TermKey type gate: catches string-built keys.
  const misses: string[] = [];
  const used = new Set<string>();
  for (const file of SOURCES) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/<Term\s+k="([^"]+)"/g)) {
      used.add(m[1]);
      if (!(m[1] in PLAIN_GLOSSARY)) misses.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(misses, []);
  const unused = Object.keys(PLAIN_GLOSSARY).filter((k) => !used.has(k));
  if (unused.length) {
    // Companion renders every entry, so unused-by-<Term> is fine — just visible.
    console.log(`glossary keys not used by <Term> (companion-only): ${unused.join(", ")}`);
  }
});

test("gloss hygiene: one plain line each, house limits", () => {
  for (const [key, { term, gloss, theme }] of Object.entries(PLAIN_GLOSSARY)) {
    assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(key), `key not kebab-case: ${key}`);
    assert.ok(term.trim().length > 0, `empty term: ${key}`);
    assert.ok(gloss.trim().length > 0, `empty gloss: ${key}`);
    assert.ok(gloss.length <= 140, `gloss over 140 chars: ${key} (${gloss.length})`);
    assert.ok(!gloss.includes("\n"), `multi-line gloss: ${key}`);
    assert.ok(GLOSSARY_THEMES.includes(theme), `unknown theme: ${key} → ${theme}`);
  }
});

test("primer: exactly six beats, each within budget", () => {
  assert.equal(PRIMER_BEATS.length, 6);
  for (const beat of PRIMER_BEATS) {
    assert.ok(beat.head.trim().length > 0);
    assert.ok(beat.body.trim().length > 0);
    assert.ok(beat.body.length <= 260, `beat body over 260 chars: ${beat.head}`);
  }
});
