import { BigInt } from "@graphprotocol/graph-ts";
import { assert, describe, test, clearStore, afterEach } from "matchstick-as";
import { handlePricePosted } from "../src/oracle";
import { loadRing, pickArrival, unbenchmarkedReason, slippageBp, divRound, bucketOf, RING_DEPTH } from "../src/tca";
import { decodeIndexId } from "../src/indices";
import { pricePosted, indexIdBytes, wad } from "./helpers";

describe("index id decoding", () => {
  test("round-trips a right-padded bytes32", () => {
    assert.stringEquals("ACR-INF", decodeIndexId(indexIdBytes("ACR-INF")));
    assert.stringEquals("ACR-DATA", decodeIndexId(indexIdBytes("ACR-DATA")));
  });
});

describe("arrival selection", () => {
  afterEach(() => { clearStore(); });

  test("a print posted at exactly settledAt IS the arrival", () => {
    // The whole convention hangs on `<=` rather than `<`. One character.
    handlePricePosted(pricePosted("ACR-INF", wad(10), 3600, 1000, 1));
    const ring = loadRing("ACR-INF");
    assert.i32Equals(0, pickArrival(ring, BigInt.fromI32(1000)));
  });

  test("one second before the boundary selects the PREVIOUS print", () => {
    // Paired with the test above, this pins the comparison direction. Either
    // test alone still passes with the operator inverted.
    handlePricePosted(pricePosted("ACR-INF", wad(10), 3600, 1000, 1));
    handlePricePosted(pricePosted("ACR-INF", wad(20), 7200, 2000, 2));
    const ring = loadRing("ACR-INF");
    // Slot 0 is the newest print (postedAt 2000); slot 1 is the older one.
    assert.i32Equals(1, pickArrival(ring, BigInt.fromI32(1999)));
    assert.i32Equals(0, pickArrival(ring, BigInt.fromI32(2000)));
    assert.bigIntEquals(BigInt.fromI32(1000), ring.postedAts[1]);
    assert.bigIntEquals(BigInt.fromI32(2000), ring.postedAts[0]);
  });

  test("a settlement older than every print is NOT benchmarked", () => {
    // Never a silent 0 bp: no qualifying print must surface as null, not zero.
    handlePricePosted(pricePosted("ACR-INF", wad(10), 3600, 5000, 1));
    const ring = loadRing("ACR-INF");
    assert.i32Equals(-1, pickArrival(ring, BigInt.fromI32(4999)));
    assert.stringEquals("NO_PRINT_YET", unbenchmarkedReason(ring));
  });

  test("the ring is bounded and evicts the oldest", () => {
    for (let i = 1; i <= RING_DEPTH + 4; i++) {
      handlePricePosted(pricePosted("ACR-INF", wad(10), 3600 * i, 1000 * i, i));
    }
    const ring = loadRing("ACR-INF");
    assert.i32Equals(RING_DEPTH, ring.printIds.length);
    // Newest first, and the evicted early prints are unreachable rather than
    // wrapping around to a wrong neighbour.
    assert.bigIntEquals(BigInt.fromI32(1000 * (RING_DEPTH + 4)), ring.postedAts[0]);
    // The evicted early prints are unreachable, not wrapped to a wrong neighbour.
    assert.i32Equals(-1, pickArrival(ring, BigInt.fromI32(1000)));
    assert.stringEquals("RING_UNDERFLOW", unbenchmarkedReason(ring));
  });

  test("prints for different indices do not share a ring", () => {
    handlePricePosted(pricePosted("ACR-INF", wad(10), 3600, 1000, 1));
    handlePricePosted(pricePosted("ACR-GPU", wad(99), 3600, 2000, 2));
    assert.i32Equals(1, loadRing("ACR-INF").printIds.length);
    assert.i32Equals(1, loadRing("ACR-GPU").printIds.length);
  });

  test("an out-of-order postedAt inserts by position, not at the front", () => {
    // Two oracles post the same index during the v1 -> v2 overlap, so a print
    // can arrive behind the ring head. Ordering must come from postedAt.
    handlePricePosted(pricePosted("ACR-INF", wad(10), 3600, 3000, 1));
    handlePricePosted(pricePosted("ACR-INF", wad(20), 7200, 1000, 2));
    const ring = loadRing("ACR-INF");
    assert.bigIntEquals(BigInt.fromI32(3000), ring.postedAts[0]);
    assert.bigIntEquals(BigInt.fromI32(1000), ring.postedAts[1]);
  });
});

describe("slippage arithmetic", () => {
  test("paying the arrival price exactly is zero bp", () => {
    assert.bigIntEquals(BigInt.zero(), slippageBp(wad(10), wad(10)));
  });

  test("one percent over arrival is 100 bp", () => {
    const arrival = BigInt.fromI32(10000);
    assert.bigIntEquals(BigInt.fromI32(100), slippageBp(BigInt.fromI32(10100), arrival));
  });

  test("paying under arrival is negative", () => {
    const arrival = BigInt.fromI32(10000);
    assert.bigIntEquals(BigInt.fromI32(-100), slippageBp(BigInt.fromI32(9900), arrival));
  });

  test("rounding is symmetric about zero — no bias toward payer or seller", () => {
    // Truncation would make +x and -x round differently and quietly tilt every
    // volume-weighted number in one direction.
    const arrival = BigInt.fromI32(30000);
    const over = slippageBp(BigInt.fromI32(30001), arrival);
    const under = slippageBp(BigInt.fromI32(29999), arrival);
    assert.bigIntEquals(over, under.neg());
  });

  test("divRound rounds half away from zero in both directions", () => {
    assert.bigIntEquals(BigInt.fromI32(2), divRound(BigInt.fromI32(3), BigInt.fromI32(2)));
    assert.bigIntEquals(BigInt.fromI32(-2), divRound(BigInt.fromI32(-3), BigInt.fromI32(2)));
  });

  test("a zero arrival cannot divide by zero", () => {
    assert.bigIntEquals(BigInt.zero(), slippageBp(wad(10), BigInt.zero()));
  });

  test("a huge slippage does not wrap — the worst payer stays the worst", () => {
    // With an i32 this overflows negative and the worst overpayer in the tape
    // renders as the best. This is why slippageBp is a BigInt.
    const big = slippageBp(wad(1000000), BigInt.fromI32(1));
    assert.assertTrue(big.gt(BigInt.fromI32(2147483647)));
  });
});

describe("histogram buckets", () => {
  test("each boundary lands in exactly one bucket", () => {
    assert.i32Equals(0, bucketOf(BigInt.fromI32(-101)));
    assert.i32Equals(1, bucketOf(BigInt.fromI32(-100)));
    assert.i32Equals(1, bucketOf(BigInt.fromI32(-1)));
    assert.i32Equals(2, bucketOf(BigInt.zero()));
    assert.i32Equals(2, bucketOf(BigInt.fromI32(49)));
    assert.i32Equals(3, bucketOf(BigInt.fromI32(50)));
    assert.i32Equals(4, bucketOf(BigInt.fromI32(100)));
    assert.i32Equals(5, bucketOf(BigInt.fromI32(200)));
    assert.i32Equals(6, bucketOf(BigInt.fromI32(500)));
    assert.i32Equals(6, bucketOf(BigInt.fromI32(99999)));
  });
});
