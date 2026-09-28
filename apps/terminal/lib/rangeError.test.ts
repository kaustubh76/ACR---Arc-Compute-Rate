import test from "node:test";
import assert from "node:assert/strict";
import { isRangeError } from "./rpcErrors";

/* Narrowing cures a too-wide range and does nothing for a throttle, so the two
   must not be confused: measured once, treating a 429 as "too wide" turned a
   four-page 7.9h walk into 1264 blocks. Arc MAINNET refuses in TWO ways
   (measured 2026-09-28) and only the first was recognised here. */

test("a result cap (-32602) is a range error — it even names the retry range", () => {
  assert.equal(
    isRangeError(new Error(
      "request exceeded max allowed range: query exceeds max results 2000, " +
        "retry with the range 23142054-23142123",
    )),
    true,
  );
});

test("a block cap (-32012, 'requested range too large') is a range error too", () => {
  // Address-filtered on Arc mainnet: 5000 blocks answer, 10000 do not. Missing
  // this made an over-wide window look transient, so the same width was
  // re-asked twice before the ladder narrowed.
  assert.equal(isRangeError(new Error("requested range too large")), true);
  assert.equal(isRangeError(new Error("RPC error -32012: requested range too large")), true);
});

test("Arc testnet's older shapes still count", () => {
  assert.equal(isRangeError(new Error("413 Payload Too Large")), true);
  assert.equal(isRangeError(new Error("limit exceeded")), true);
});

test("throttling is NOT a range error — the same range, after a backoff", () => {
  assert.equal(isRangeError(new Error("429 Too Many Requests")), false);
  assert.equal(isRangeError(new Error("HTTP 429")), false);
  // A 429 whose body happens to mention results must still read as a throttle.
  assert.equal(isRangeError(new Error("429 Too Many Requests: exceeds max results")), false);
});
