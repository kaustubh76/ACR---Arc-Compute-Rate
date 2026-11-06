import { test } from "node:test";
import assert from "node:assert/strict";

import { accruedFrom, principalFrom, reachedStart, usdc } from "./floatYield";

/* Numbers from the live sleeve on chain 5042002, so these are the shapes the
   panel actually meets rather than invented ones. The hero transaction in the
   submission is `Pulled(530250, 530250)` — asked for and delivered the same. */

test("the basis is what went in minus what came back out", () => {
  assert.equal(principalFrom([5_000_000n, 1_000_000n], [530_250n]), 5_469_750n);
  assert.equal(principalFrom([], []), 0n);
  assert.equal(principalFrom([7_000_000n], []), 7_000_000n);
});

test("it counts what was DELIVERED, never what was requested", () => {
  /* A venue may hand back less than it was asked for, which is why
     `withdrawExact` emits both numbers. Counting the request would remove money
     from the basis that never actually left the venue, inflating the gain. */
  const requested = 1_000_000n;
  const delivered = 999_000n;
  const byDelivered = principalFrom([5_000_000n], [delivered]);
  const byRequested = principalFrom([5_000_000n], [requested]);
  assert.equal(byDelivered, 4_001_000n);
  assert.ok(byDelivered > byRequested, "using the request understates the basis");
  assert.ok(
    accruedFrom(4_100_000n, byDelivered, true)! < accruedFrom(4_100_000n, byRequested, true)!,
    "and therefore overstates the gain",
  );
});

test("the gain is signed, because a venue can mark down", () => {
  assert.equal(accruedFrom(5_522_650n, 5_400_000n, true), 122_650n);
  assert.equal(accruedFrom(5_400_000n, 5_400_000n, true), 0n);
  /* The one a flattering meter would hide. A share-priced venue's
     `convertToAssets` can fall, and the panel has to be able to print it. */
  assert.equal(accruedFrom(5_300_000n, 5_400_000n, true), -100_000n);
  assert.ok(usdc(accruedFrom(5_300_000n, 5_400_000n, true)!) < 0);
});

test("an incomplete basis yields no number at all", () => {
  /* Missing the opening deposits makes the gain look bigger by exactly what was
     missed, and there is no way to bound that from inside the window. So it is
     withheld rather than estimated. */
  assert.equal(accruedFrom(5_522_650n, 100_000n, false), null);
  assert.equal(accruedFrom(5_522_650n, 5_400_000n, false), null);
});

test("completeness means reaching the sleeve's own first block, not running out of pages", () => {
  const SLEEVE_BLOCK = 70_931_003;
  assert.ok(reachedStart(70_931_003, SLEEVE_BLOCK), "landing exactly on it counts");
  assert.ok(reachedStart(70_930_000, SLEEVE_BLOCK), "going past it counts");
  assert.ok(!reachedStart(70_950_000, SLEEVE_BLOCK), "stopping short does not");
  /* No floor configured is not completeness. A walk that saw plenty of events
     still cannot know whether older ones exist. */
  assert.ok(!reachedStart(0, null));
  assert.ok(!reachedStart(70_931_003, Number.NaN));
});

test("units convert signed and without losing a cent", () => {
  assert.equal(usdc(5_522_650n), 5.52265);
  assert.equal(usdc(-100_000n), -0.1);
  assert.equal(usdc(0n), 0);
  assert.equal(usdc(1n), 0.000001);
});
