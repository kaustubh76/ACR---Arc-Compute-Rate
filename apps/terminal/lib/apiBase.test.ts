import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_SELLER, MAINNET_SELLER, isHostFailure, sellerBase, sellerCandidates } from "./apiBase";

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
