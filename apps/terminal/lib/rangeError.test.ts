import test from "node:test";
import assert from "node:assert/strict";
import { isRangeError, isThrottled } from "./rpcErrors";

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

test("a node telling us to slow down is named as that, not as a range", () => {
  /* The overlap that makes this worth a test: Arc's throttle message carries
     the phrase `isRangeError` matches on, so the two predicates disagree about
     the same error and the throttle one has to be asked first. */
  const throttle = new Error("rate limit exceeded");
  assert.ok(isThrottled(throttle));
  assert.ok(isRangeError(throttle), "the overlap is real, which is why order matters");

  assert.ok(isThrottled({ code: -32005, message: "whatever the node says" }));
  assert.ok(isThrottled(new Error("HTTP 429 Too Many Requests")));
  assert.ok(isThrottled({ message: "outer", cause: { message: "rate limit exceeded" } }));
});

test("a revert is not a throttle, so an absent value stays absent", () => {
  /* The reserve sleeve reverts by design. If that read were classified as a
     throttle it would retry three times and then report the chain as busy,
     which is the opposite of the truth and hides a banner the product needs. */
  assert.ok(!isThrottled(new Error("execution reverted")));
  assert.ok(!isThrottled(new Error("returned no data (0x)")));
  assert.ok(!isThrottled(new Error("query exceeds max results 2000, retry with the range 1-2")));
  assert.ok(!isThrottled(null));
  assert.ok(!isThrottled(undefined));
});

test("a bare 403 is the other throttle shape, not a refusal to answer", () => {
  /* Measured on the live float vault: a burst of eth_call went from -32005 to
     HTTP 403 with no body. This file's own header recorded that shape years
     before anything branched on it. */
  assert.ok(isThrottled(new Error("HTTP request failed. Status: 403 Forbidden")));
  assert.ok(isThrottled({ message: "fetch failed", cause: { message: "403" } }));
  assert.ok(!isThrottled(new Error("execution reverted: not pending owner")));
});
