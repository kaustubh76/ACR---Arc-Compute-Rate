import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/* The wiring gate: is the chain actually threaded, everywhere?
 *
 * WHY A SCAN AND NOT A UNIT TEST. One deployment serves two chains, and the
 * plumbing is spread over ~40 route handlers. I converted them with a script and
 * then nearly shipped the half that matters missing: the chain reached every
 * FETCH and sixteen of the RESPONSES carried no `chain` at all. `tsc` was clean,
 * 242 tests passed, and the guard that holds regardless of caching was simply
 * absent while the diff looked finished. It was found by probing all sixteen
 * routes against a running build — which is not something CI can do, because CI
 * has no press.
 *
 * So the invariant moves here, where a scan can hold it for every future route
 * without anyone remembering to check. Same mechanism and same argument as
 * `lib/mainnetOnly.test.ts` and `lib/coverage.test.ts`: a ledger of exemptions,
 * each of which has to argue for itself, and an assertion that the ledger
 * carries nothing it does not need.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const API = join(ROOT, "app", "api");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

const ROUTES = routeFiles(API);

/** Handlers that legitimately never build an `Envelope`, each with the reason.
 *  Adding to this map is a conscious act that leaves an argument behind. */
const NO_ENVELOPE: Record<string, string> = {
  "app/api/buy/route.ts":
    "answers its own LiveBuyResponse shape, which carries a `fetchedAt` and is " +
    "not an Envelope. My conversion script stamped it anyway and tsc refused, " +
    "which is the only reason this is a considered exemption rather than a bug.",
};

/* ONE ENTRY, AND IT WAS THIRTEEN. The first draft of this ledger listed every
   handler I BELIEVED had no envelope — the desk proxy, the ops console, the
   humanid routes, the probe, the screen. Twelve of them exempt nothing: they
   build no envelope at all, so the scan never reaches them and the entry sits
   there waiting to excuse the next route that forgets. The unused-entry
   assertion below is what found that, on its first run, against its own author.
   Derive a ledger from what the scan actually flags; never from what you think
   it will. */

test("every route handler resolves the chain for the request", () => {
  // The chain may never be a module-level value: a warm lambda serves many
  // visitors, so a hoisted chain is one visitor's choice applied to the next
  // one's render. Resolving it per request is the whole contract.
  const missing = ROUTES.filter((f) => !readFileSync(f, "utf8").includes("requestChain("))
    .map((f) => relative(ROOT, f));
  assert.deepEqual(
    missing,
    [],
    "these handlers never resolve the chain, so they answer from whichever rig " +
      "happens to be built:\n  " + missing.join("\n  "),
  );
});

test("the chain is never hoisted to module scope in a handler", () => {
  const hoisted: string[] = [];
  for (const f of ROUTES) {
    const src = readFileSync(f, "utf8");
    // A resolve that is not indented sits outside a function body.
    if (/^const chain = requestChain\(/m.test(src)) hoisted.push(relative(ROOT, f));
  }
  assert.deepEqual(hoisted, [], `the chain must be per request, not per module: ${hoisted.join(", ")}`);
});

test("every envelope a handler builds carries the chain that produced it", () => {
  /* THE ONE I NEARLY SHIPPED MISSING. `fetcherFor` refuses an answer whose
     `chain` is not the one it asked for, and treats an ABSENT stamp as a
     mismatch — so an unstamped route does not render another chain's numbers, it
     renders an error. That is the right failure and a terrible silent default:
     the surface would just look broken on the default chain for no visible
     reason. The stamp is the fix; this is what keeps it. */
  const unstamped: string[] = [];
  for (const f of ROUTES) {
    const rel = relative(ROOT, f);
    if (rel in NO_ENVELOPE) continue;
    const src = readFileSync(f, "utf8");
    if (!src.includes("fetchedAt: Date.now()")) continue;
    // Either stamped inline, or built through the helper that demands it.
    const stamped = /fetchedAt: Date\.now\(\),\s*chain\s*[,}]/.test(src) || /envelope\(/.test(src);
    if (!stamped) unstamped.push(rel);
  }
  assert.deepEqual(
    unstamped,
    [],
    "these build an envelope with no chain on it:\n  " + unstamped.join("\n  "),
  );
});

test("the no-envelope ledger carries no entry it does not need", () => {
  /* The half that keeps a ledger honest. An entry that stops being needed would
     otherwise sit there excusing the next route that forgets — which is exactly
     how `verify_claims` once measured a COLLECTED count and so could not see a
     red suite. */
  const stale = Object.keys(NO_ENVELOPE).filter((rel) => {
    try {
      const src = readFileSync(join(ROOT, rel), "utf8");
      // Needed only if the file WOULD otherwise be flagged.
      const wouldFlag =
        src.includes("fetchedAt: Date.now()") &&
        !/fetchedAt: Date\.now\(\),\s*chain\s*[,}]/.test(src) &&
        !/envelope\(/.test(src);
      return !wouldFlag;
    } catch {
      return true; // the file is gone; the entry outlived it
    }
  });
  assert.deepEqual(stale, [], `delete these — they no longer exempt anything: ${stale.join(", ")}`);
});

test("a shared cache directive is never hand-written past the chain", () => {
  /* Vercel's CDN keys a stored response on method and URL, not on cookies —
     measured on the live deployment, two sequential GETs of /api/terminal went
     `x-vercel-cache: MISS` then `HIT`. So a `public, s-maxage=…` written straight
     into a handler would let one visitor's chain be served to the next. It has to
     go through `chainHeaders`, which downgrades a non-default chain to
     `private, no-store`. */
  /* THE FIRST VERSION OF THIS MATCHED NOTHING, which is worse than not having
     it. It looked for the exact shape `"Cache-Control": "public, s-maxage…`,
     and every compliant route passes the directive as the FIRST ARGUMENT to
     `chainHeaders(...)` while every offender hoists it to a const or picks it
     with a ternary — so the regex found zero files out of 36 and four real
     violations went through. A gate that cannot fail is a gate that is not
     being run, and this file spends two paragraphs on exactly that lesson
     about the no-envelope ledger below.

     The rule, stated instead of pattern-matched: a shared directive may appear
     in a handler only as an argument to `chainHeaders`, which is what
     downgrades it on a non-default chain. So every occurrence of the directive
     must sit on a line that also calls it. */
  const raw = ROUTES.filter((f) => {
    const src = readFileSync(f, "utf8");
    return src
      .split("\n")
      .some((line) => line.includes("public, s-maxage") && !line.includes("chainHeaders("));
  }).map((f) => relative(ROOT, f));
  assert.deepEqual(
    raw,
    [],
    "route a shared directive through chainHeaders(directive, chain):\n  " + raw.join("\n  "),
  );
});

test("the client keys every proxy call on the chain, and verifies the answer", () => {
  const src = readFileSync(join(ROOT, "lib", "useLive.ts"), "utf8");
  // A bare `fetcher` on an /api/ key would neither key the cache nor check the
  // stamp. `fetcherFor(chain)` does both.
  assert.ok(!/,\s*fetcher,/.test(src), "every useSWR must use fetcherFor(chain), not the bare fetcher");
  assert.match(src, /fetcherFor/, "the verifying fetcher must be in use");
  // Every literal proxy path is wrapped. Counted rather than matched one by one,
  // because the count is what drifts when a hook is added.
  // One apiKey per useSWR, not per path literal: a ternary key is two literals
  // and one call, which is correct — counting literals said otherwise.
  const calls = [...src.matchAll(/useSWR[<(]/g)].length;
  const keyed = [...src.matchAll(/apiKey\(/g)].length;
  assert.ok(keyed >= calls, `${calls} useSWR calls but only ${keyed} apiKey() calls`);
});
