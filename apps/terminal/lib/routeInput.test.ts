/* Caller input that reaches an upstream URL or a shared cache key
 * (lib/routeInput.ts), and the routes that must go through it. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { dryRunParams, historyParam, payerParam, priceParam } from "./routeInput";

const TERMINAL = join(dirname(fileURLToPath(import.meta.url)), "..");
const route = (p: string) => readFileSync(join(TERMINAL, p), "utf8");
const A = "0x784e6D2d4870174aD1aEa3d7446F2377D0c6A05d";

test("a payer is an address, lower-cased, or absent", () => {
  assert.deepEqual(payerParam(A), { ok: true, payer: A.toLowerCase() });
  assert.deepEqual(payerParam(` ${A} `), { ok: true, payer: A.toLowerCase() });
  assert.deepEqual(payerParam(null), { ok: true, payer: null });
  assert.deepEqual(payerParam(""), { ok: true, payer: null });
});

test("a payer that would steer the press path is refused in words", () => {
  // The four shapes measured or tried against production on 2026-10-16.
  for (const raw of ["../health#", "../x402/info#", "../health?", "0x784e/../../health", "0x123", A + "/x", "zzz"]) {
    const r = payerParam(raw);
    assert.equal(r.ok, false, `${raw} was accepted`);
    if (!r.ok) assert.match(r.error, /0x wallet address/);
  }
});

test("history is one of the indices, or nothing", () => {
  assert.equal(historyParam("ACR-INF"), "ACR-INF");
  // `constructor` passed `prints[historyFor]` through the prototype chain.
  for (const raw of [null, "", "constructor", "__proto__", "toString", "ACR-NOPE", "acr-inf", "ACR-INF/../x"]) {
    assert.equal(historyParam(raw), null, `${raw} was accepted`);
  }
});

test("the tape route checks the payer before it builds a press path", () => {
  const src = route("app/api/tape/route.ts");
  assert.match(src, /payerParam\(url\.searchParams\.get\("payer"\)\)/, "the tape route must read ?payer= through payerParam");
  assert.match(src, /status: 422/, "a refused payer must be a 422, like /api/par");
  // The raw parameter must not survive to the `/tca/${…}` template.
  assert.doesNotMatch(src, /searchParams\.get\("payer"\)\s*;/, "a raw ?payer= read is back");
});

test("the onchain route reads history only for a real index", () => {
  assert.match(route("app/api/onchain/route.ts"), /historyParam\(req\.nextUrl\.searchParams\.get\("history"\)\)/);
  // An own-property check, so no prototype key can stand in for a print.
  assert.match(route("lib/onchain.ts"), /Object\.hasOwn\(prints, historyFor\)/);
});

test("a funding price is a finite, non-negative number, else zero", () => {
  assert.equal(priceParam("0.0001"), 0.0001);
  // `Math.max(0, Number(x) || 0)` let Infinity through: Number("Infinity") is truthy.
  for (const raw of [null, "", "Infinity", "-Infinity", "NaN", "-1", "abc", "1e400"]) {
    assert.equal(priceParam(raw), 0, `${raw} was accepted`);
  }
  assert.match(route("app/api/wallet/balances/route.ts"), /priceParam\(req\.nextUrl\.searchParams\.get\("price"\)\)/);
});

test("a dry run takes what the chain can classify, and names what it cannot", () => {
  const ok = dryRunParams(
    new URLSearchParams({ agent: "scout", seller: "0x" + "ab".repeat(20), units: "4000", quote: "4.8" }),
  );
  assert.ok(ok.ok);
  assert.deepEqual(ok.req, { agent: "scout", seller: "0x" + "ab".repeat(20), units: 4000, quoteUsdc: 4.8 });

  const withIndex = dryRunParams(
    new URLSearchParams({
      agent: "waster",
      seller: "0x" + "cd".repeat(20),
      units: "1",
      quote: "0",
      index: "0x" + "ef".repeat(32),
    }),
  );
  assert.ok(withIndex.ok);
  assert.equal(withIndex.req.index, "0x" + "ef".repeat(32));
});

test("a dry run never bounces what the ladder has a rung for", () => {
  /* The rungs a reader is meant to be able to trip. If any of these came back
     as a parameter error, the endpoint would be hiding the refusal it exists to
     demonstrate. */
  const seller = "0x" + "ab".repeat(20);
  const absurdUnits = dryRunParams(new URLSearchParams({ agent: "scout", seller, units: "1e12", quote: "1" }));
  assert.ok(absurdUnits.ok, "absurd units is rung 6, not a parameter error");

  const overBand = dryRunParams(new URLSearchParams({ agent: "scout", seller, units: "4000", quote: "9999" }));
  assert.ok(overBand.ok, "a quote outside the band is rung 10, not a parameter error");

  const unknownAgent = dryRunParams(new URLSearchParams({ agent: "nobody", seller, units: "4000", quote: "1" }));
  assert.ok(unknownAgent.ok, "an unknown agent is rung 2, not a parameter error");

  const unlistedSeller = dryRunParams(
    new URLSearchParams({ agent: "scout", seller: "0x" + "00".repeat(19) + "01", units: "4000", quote: "1" }),
  );
  assert.ok(unlistedSeller.ok, "a seller not on the allowlist is rung 4, not a parameter error");
});

test("a dry run refuses only what it cannot encode", () => {
  const seller = "0x" + "ab".repeat(20);
  const bad: Record<string, string>[] = [
    { agent: "", seller, units: "1", quote: "1" },
    { agent: "a".repeat(65), seller, units: "1", quote: "1" },
    { agent: "sco ut", seller, units: "1", quote: "1" },
    { agent: "scout", seller: "0xnope", units: "1", quote: "1" },
    { agent: "scout", seller: seller.slice(0, -1), units: "1", quote: "1" },
    { agent: "scout", seller, units: "-1", quote: "1" },
    { agent: "scout", seller, units: "abc", quote: "1" },
    { agent: "scout", seller, units: "1", quote: "-1" },
    { agent: "scout", seller, units: "1", quote: "abc" },
    { agent: "scout", seller, units: "1", quote: "1e300" },
    { agent: "scout", seller, units: "1", quote: "1", index: "0xbeef" },
  ];
  for (const p of bad) {
    const r = dryRunParams(new URLSearchParams(p));
    assert.equal(r.ok, false, `should have refused ${JSON.stringify(p)}`);
    if (!r.ok) assert.ok(r.error.length > 0, "a refusal must say what was wrong");
  }
});
