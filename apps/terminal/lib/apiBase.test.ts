import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_SELLER, MAINNET_SELLER, chainMismatch, isHostFailure, publishedSeller, sellerBase, sellerCandidates, servesPath } from "./apiBase";

/* The default that matters is the one nobody sets. Eight places spelled
   `?? "http://127.0.0.1:8000"`, which is wrong in the only place it is ever
   reached: a production build on a server, where that host is nothing. */

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(env)) delete (process.env as Record<string, string | undefined>)[k];
    Object.assign(process.env, saved);
  }
}

test("a production build with NOTHING set points at the production seller", () => {
  withEnv({ NEXT_PUBLIC_ACR_API: undefined, NODE_ENV: "production" }, () => {
    assert.equal(sellerBase(), MAINNET_SELLER);
  });
});

test("development with nothing set still points at the local press", () => {
  withEnv({ NEXT_PUBLIC_ACR_API: undefined, NODE_ENV: "development" }, () => {
    assert.equal(sellerBase(), LOCAL_SELLER);
  });
});

test("an explicit NEXT_PUBLIC_ACR_API wins in either mode — forks are not constrained", () => {
  for (const mode of ["production", "development"]) {
    withEnv({ NEXT_PUBLIC_ACR_API: "https://seller.example", NODE_ENV: mode }, () => {
      assert.equal(sellerBase(), "https://seller.example");
    });
  }
});

test("a trailing slash is trimmed, so `${base}${path}` never doubles it", () => {
  withEnv({ NEXT_PUBLIC_ACR_API: "https://seller.example/", NODE_ENV: "production" }, () => {
    assert.equal(sellerBase(), "https://seller.example");
  });
});

test("an empty or whitespace value is treated as unset, not as an empty host", () => {
  withEnv({ NEXT_PUBLIC_ACR_API: "   ", NODE_ENV: "production" }, () => {
    assert.equal(sellerBase(), MAINNET_SELLER);
  });
});

/* The fallback rung. `ACR_API` named a SUSPENDED Render service for two days and
   every route on the live terminal served the archived bundle instead — silently,
   which is why it lasted. These pin the policy that fixes it. */

test("with no override there is one candidate, so there is no fallback behaviour", () => {
  assert.deepEqual(sellerCandidates("", MAINNET_SELLER), [MAINNET_SELLER]);
});

test("an override is tried FIRST — a working one is never overridden", () => {
  assert.deepEqual(sellerCandidates("https://staging.example", MAINNET_SELLER), [
    "https://staging.example",
    MAINNET_SELLER,
  ]);
});

test("an override equal to the published base collapses to one candidate", () => {
  assert.deepEqual(sellerCandidates(MAINNET_SELLER, MAINNET_SELLER), [MAINNET_SELLER]);
  // ...including when only a trailing slash differs, or it would retry itself.
  assert.deepEqual(sellerCandidates(MAINNET_SELLER + "/", MAINNET_SELLER), [MAINNET_SELLER]);
});

test("whitespace is not a host", () => {
  assert.deepEqual(sellerCandidates("   ", MAINNET_SELLER), [MAINNET_SELLER]);
});

test("only 5xx means the host is not serving", () => {
  // The exact fault this rung exists for: Render's suspended-service page.
  assert.equal(isHostFailure(503), true);
  assert.equal(isHostFailure(500), true);
  assert.equal(isHostFailure(502), true);
});

test("an answer is not a failure — 402 and 404 must never move us off the host", () => {
  // 402 is the x402 paywall working exactly as designed, and 404 is
  // "no open series for ACR-INF" on an unseeded venue. Falling back on either
  // would send a paid request to a different seller than the one quoted it.
  assert.equal(isHostFailure(402), false);
  assert.equal(isHostFailure(404), false);
  assert.equal(isHostFailure(200), false);
  assert.equal(isHostFailure(401), false);
  assert.equal(isHostFailure(499), false);
});

test("the cushion ignores BOTH env overrides — the bug that made the rung inert", () => {
  // Measured on the live deployment: ACR_API and NEXT_PUBLIC_ACR_API were set to
  // the SAME suspended host, so a cushion derived from sellerBase() equalled the
  // configured host, collapsed to one candidate, and never fired.
  withEnv({ NEXT_PUBLIC_ACR_API: "https://dead.example", NODE_ENV: "production" }, () => {
    assert.equal(publishedSeller(), MAINNET_SELLER);
    assert.deepEqual(sellerCandidates("https://dead.example", publishedSeller()), [
      "https://dead.example",
      MAINNET_SELLER,
    ]);
  });
});

/* Chain identity. The rung honoured a WORKING configured host — correct for a
   staging seller, wrong for one on another chain. `acr-api-1fto` was resumed,
   started answering 200, and the terminal went straight back to it and served
   live chain-5042002 data under a mainnet UI. Health is not the only test. */

test("a seller on the build's own chain is accepted", () => {
  assert.equal(chainMismatch(5042, 5042), null);
  assert.equal(chainMismatch(5042, "5042"), null, "a string id from JSON still matches");
});

test("a healthy seller on ANOTHER chain is refused, and the reason names both", () => {
  const why = chainMismatch(5042, 5042002);
  assert.ok(why, "5042002 is not 5042");
  assert.ok(why!.includes("5042002") && why!.includes("5042"), why!);
  // The distinction that matters: it is not broken, it is not ours.
  assert.ok(/not serving this product/.test(why!), why!);
});

test("absence of evidence is not evidence — an unknown chain id is allowed", () => {
  // Same principle as an unreadable press balance never stopping a print:
  // refusing a good seller because a probe came back empty is the worse bug.
  for (const unknown of [undefined, null, "", "not-a-number", 0, -1, NaN]) {
    assert.equal(chainMismatch(5042, unknown), null, `${String(unknown)} must not disqualify`);
  }
});

test("a build with no known chain polices nothing", () => {
  // A bundle without a chain_id cannot judge anyone.
  for (const build of [0, -1, NaN]) {
    assert.equal(chainMismatch(build, 5042002), null);
  }
});

// ───────────────────── does this host have the route at all?

test("servesPath matches a templated route against a concrete one", () => {
  const served = ["/health", "/par", "/operator/statement/{business}", "/tca/{payer}", "/tca/human"];
  assert.ok(servesPath(served, "/par"));
  assert.ok(servesPath(served, "/par?unit=%24%2F1k%20tokens&billed_usdc=1"), "a query is not part of the path");
  assert.ok(servesPath(served, "/operator/statement/acr-fleet"));
  assert.ok(servesPath(served, "/operator/statement/acr-fleet?days=30"));
  assert.ok(servesPath(served, "/tca/0xabc"));
});

test("servesPath says no for a route this host simply does not have", () => {
  /* The live case: the mainnet press serves 44 routes and none of these. It
     answers 404 — healthily — and the terminal used to report that as "the
     press did not answer", which told a visitor a running service was down. */
  const served = ["/health", "/prints", "/tca/{payer}"];
  assert.equal(servesPath(served, "/par"), false);
  assert.equal(servesPath(served, "/operator/traction"), false);
  assert.equal(servesPath(served, "/operator/statement/acr-fleet"), false);
});

test("a template does not match across segment boundaries", () => {
  // `{business}` is one segment. Without this, `/operator/statement/a/b` would
  // look served, and a genuine 404 would be mislabelled as a present route.
  const served = ["/operator/statement/{business}"];
  assert.equal(servesPath(served, "/operator/statement/a/b"), false);
  assert.equal(servesPath(served, "/operator/statement"), false);
});

test("a host that lists the route keeps its ordinary 404", () => {
  /* THE DISTINCTION THIS IS FOR. An unknown business on a press that HAS the
     route is a real not-found and must not be reported as a stale deployment —
     otherwise every typo in a slug would blame the operator's image. */
  const served = ["/operator/statement/{business}"];
  assert.ok(servesPath(served, "/operator/statement/nobody"), "the route exists; the business does not");
});

test("the availability check and the ledger's 404 agree about one host", () => {
  /* THE CONFLATION THIS CLOSES. The press answers 404 both for a route it does
     not have and for `no business registered as 'x'`. `/developers` uses this
     to decide whether to offer a run button and the ledger proxy uses it to
     decide whether "not on this press" is the honest label — so they must
     reach the same verdict from the same list, or the page will offer a button
     for a route the download already calls missing. */
  const press = ["/health", "/operator/ledger/{business}", "/operator/traction"];
  assert.ok(servesPath(press, "/operator/ledger/acr-fleet"), "the route exists");
  assert.ok(servesPath(press, "/operator/ledger/nobody"), "and still exists for a bad slug");
  assert.equal(servesPath(press, "/par"), false, "this one genuinely is not here");

  const older = ["/health", "/prints"];
  assert.equal(servesPath(older, "/operator/ledger/acr-fleet"), false);
  assert.equal(servesPath(older, "/operator/traction"), false);
});
