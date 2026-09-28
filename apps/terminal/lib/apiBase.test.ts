import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_SELLER, MAINNET_SELLER, sellerBase } from "./apiBase";

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
