import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Does each dashboard page's JavaScript still PARSE?
 *
 * This test exists because a page shipped that did not, and nothing noticed.
 *
 * `float/app/{index,walk,venue}.html` are single files with no build step — the
 * property that lets a judge open one in a browser with no server. The cost of
 * that property is that nothing ever compiles them, so a syntax error reaches
 * `origin/main` looking exactly like working code in a diff.
 *
 * What happened: a script added the note "403: a hard Arc burst returns a bare
 * 403, not a rate-limit message" to the rate-limit predicate in both
 * Studio-authored pages, and put it INSIDE the expression:
 *
 *     /rate limit|…|\b403\b/i // 403: a hard Arc burst … message.test(
 *       `${e?.shortMessage ?? ""} …`,
 *     );
 *
 * `//` runs to end of line, so it ate `.test(`. In `walk.html` that left a
 * tagged template on a regex and an unmatched `)` — a SyntaxError, so the whole
 * inline module failed to parse and the page rendered its shell and ran nothing
 * at all. In `venue.html` the same edit produced `(m) => /regex/i`, which
 * returns a RegExp: always truthy, so every error was classified as rate
 * limiting and retried. One page dead, one silently wrong, both committed and
 * both public.
 *
 * A diff review will not catch this and neither will `forge test`, `tsc` or the
 * doc-claim audit — none of them read these files. `node --check` does, costs
 * milliseconds, and would have refused the commit.
 */
const PAGES = ["index.html", "walk.html", "venue.html"] as const;

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

/** Every `<script type="module">` body in a page, in order. */
function modules(html: string): string[] {
  return [...html.matchAll(/<script[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "");
}

test("every dashboard page's inline module parses as JavaScript", () => {
  const dir = mkdtempSync(join(tmpdir(), "acr-pages-"));
  for (const page of PAGES) {
    const html = readFileSync(join(appDir, page), "utf8");
    const mods = modules(html);

    // A page whose script we cannot find is not a page that passed — it is a
    // check that silently stopped looking. These pages each carry exactly one
    // module, and if that ever changes this assertion should be the thing that
    // says so rather than the parse quietly covering zero files.
    assert.ok(mods.length > 0, `${page}: no <script type="module"> found — has the page changed shape?`);

    mods.forEach((src, i) => {
      const file = join(dir, `${page}.${i}.mjs`);
      writeFileSync(file, src);
      try {
        execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        const err = e as { stderr?: Buffer };
        assert.fail(`${page} module ${i} does not parse:\n${String(err.stderr ?? "").slice(0, 600)}`);
      }
    });
  }
});

/**
 * The specific shape of the bug above, asserted directly.
 *
 * The parse check already catches `walk.html`'s version, but `venue.html`'s was
 * syntactically VALID and merely always true — a parser cannot see that. So
 * pin the predicate itself: it has to actually call `.test`, and no `//`
 * comment may sit between the pattern and the call.
 */
test("the rate-limit predicate calls .test rather than returning a regex", () => {
  for (const page of PAGES) {
    const html = readFileSync(join(appDir, page), "utf8");
    for (const line of html.split("\n")) {
      if (!/rate limit\|/.test(line)) continue;
      assert.ok(
        !/\/\/.*\.test\s*\(/.test(line),
        `${page}: a // comment sits before .test( on this line, which comments the call out:\n  ${line.trim()}`,
      );
      assert.ok(
        /\.test\s*\(/.test(line) || /\.test\s*\($/.test(line.trimEnd()),
        `${page}: the rate-limit pattern never reaches .test( on its own line:\n  ${line.trim()}`,
      );
    }
  }
});
