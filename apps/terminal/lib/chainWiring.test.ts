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
     in a handler only as an argument to a helper that downgrades it on a
     non-default chain. So every occurrence of the directive must sit on a line
     that calls one.

     TWO HELPERS NOW SATISFY IT, which is why this looks for either.
     `envelopeHeaders` is the stricter of the two — it calls `chainHeaders` and
     additionally refuses to cache a response whose envelope is not live — and
     every route proxying an envelope was converted to it after the front page
     was measured serving a 12-day-old archived print from the edge. The test
     below holds that stricter rule; this one holds the chain half, so that a
     future handler using plain `chainHeaders` for a response that has no
     envelope at all is still covered. */
  const raw = ROUTES.filter((f) => {
    const src = readFileSync(f, "utf8");
    return src
      .split("\n")
      .some(
        (line) =>
          line.includes("public, s-maxage") &&
          !line.includes("chainHeaders(") &&
          !line.includes("envelopeHeaders("),
      );
  }).map((f) => relative(ROOT, f));
  assert.deepEqual(
    raw,
    [],
    "route a shared directive through chainHeaders/envelopeHeaders:\n  " + raw.join("\n  "),
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

/** Handlers that send a shared directive and genuinely cannot serve a fallback,
 *  each with the reason. Derived from what the scan FLAGS, never from what I
 *  expect it to — this file's own first ledger listed thirteen handlers of
 *  which twelve exempted nothing. */
const MAY_CACHE_UNCONDITIONALLY: Record<string, string> = {};

test("a shared directive is never sent with a fallback", () => {
  /* MEASURED ON THE DEPLOYED SITE, which is the only place this was visible:
     `/api/terminal?chain=mainnet` answered `live: false` on three consecutive
     reads with an identical `fetchedAt`, serving an archived print 12.13 days
     old — while that press had one 55 minutes old and answered in 0.65s. Its
     `/terminal/data` measured 180s (hung), 34.1s, then 0.65s against a 5000ms
     budget. So a cold Render start loses, the cushion is right, and caching the
     cushion put one lost race on the front page for everyone for ~35 seconds.

     The rule predates this gate: `readHeaders` in lib/readResult.ts has always
     said a failed read must never be cached, or a transient blip becomes "a
     shared, confident lie". Three routes followed it; eleven had a single exit
     that sent the cacheable directive whatever the envelope said. `sharedCache`
     limited the blast radius to the DEFAULT chain, which is why it only ever
     showed on mainnet — the page everyone lands on.

     So: a shared directive may reach a response only through `envelopeHeaders`,
     which reads the envelope's own `live`. Taking the envelope rather than a
     boolean is deliberate; a boolean can be passed the wrong way round and this
     mistake does not fail loudly, it caches a lie and looks fine. */
  const offenders = ROUTES.filter((f) => {
    const rel = relative(ROOT, f);
    if (rel in MAY_CACHE_UNCONDITIONALLY) return false;
    const src = readFileSync(f, "utf8");
    return src
      .split("\n")
      .some((line) => line.includes("public, s-maxage") && !line.includes("envelopeHeaders("));
  }).map((f) => relative(ROOT, f));
  assert.deepEqual(
    offenders,
    [],
    "send a shared directive through envelopeHeaders(directive, chain, env):\n  " + offenders.join("\n  "),
  );
});

test("the may-cache ledger carries no entry it does not need", () => {
  const stale = Object.keys(MAY_CACHE_UNCONDITIONALLY).filter((rel) => {
    try {
      const src = readFileSync(join(ROOT, rel), "utf8");
      return !src
        .split("\n")
        .some((line) => line.includes("public, s-maxage") && !line.includes("envelopeHeaders("));
    } catch {
      return true; // the file is gone; the entry outlived it
    }
  });
  assert.deepEqual(stale, [], `delete these — they exempt nothing: ${stale.join(", ")}`);
});
