/* Caller input that reaches an upstream URL or a shared cache key
 * (lib/routeInput.ts), and the routes that must go through it. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { historyParam, payerParam, priceParam } from "./routeInput";

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
