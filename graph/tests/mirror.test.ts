import { BigInt } from "@graphprotocol/graph-ts";
import { assert, describe, test, clearStore, afterEach } from "matchstick-as";
import { handlePricePosted } from "../src/oracle";
import { handleSettlementOpened, handleSettlementFinalized } from "../src/mirror";
import { SellerDay } from "../generated/schema";
import { pricePosted, settlementOpened, settlementFinalized, sidBytes, PAYER, SELLER } from "./helpers";

// $0.0001 per unit, in the WAD 1e18 scale prints are published in.
const ARRIVAL = BigInt.fromString("100000000000000");
const ONE_UNIT = BigInt.fromString("1000000000000000000"); // WAD 1e18

function id(label: string): string {
  return sidBytes(label).toHexString();
}

const DAY = 86400;
function sellerDay(blockTs: i32): string {
  return SELLER.toHexString() + "-" + (blockTs / DAY).toString();
}
function payerDay(blockTs: i32): string {
  return PAYER.toHexString() + "-" + (blockTs / DAY).toString();
}

/** b0..b6 must partition the benchmarked settlements — no gap, no overlap. */
function assertBucketsSumToN(day: string): void {
  const e = SellerDay.load(day)!;
  const sum = e.b0 + e.b1 + e.b2 + e.b3 + e.b4 + e.b5 + e.b6;
  assert.i32Equals(e.n, sum);
}

describe("settlement mirror", () => {
  afterEach(() => { clearStore(); });

  test("a settlement paid exactly at arrival reads zero slippage", () => {
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handleSettlementOpened(settlementOpened("s1", "ACR-INF", BigInt.fromI32(100), 1500, 1510, 2));
    handleSettlementFinalized(settlementFinalized("s1", ONE_UNIT, 1600, 3));

    // 100 USDC-1e6 over 1 WAD unit == 1e14 WAD == the arrival print exactly.
    assert.fieldEquals("Settlement", id("s1"), "unitPrice", "100000000000000");
    assert.fieldEquals("Settlement", id("s1"), "benchmarked", "true");
    assert.fieldEquals("Settlement", id("s1"), "slippageBp", "0");
    assert.fieldEquals("Settlement", id("s1"), "slippageTenthBp", "0");
  });

  test("one percent over arrival reads 100 bp, and 1000 tenth-bp", () => {
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handleSettlementOpened(settlementOpened("s2", "ACR-INF", BigInt.fromI32(101), 1500, 1510, 2));
    handleSettlementFinalized(settlementFinalized("s2", ONE_UNIT, 1600, 3));

    assert.fieldEquals("Settlement", id("s2"), "unitPrice", "101000000000000");
    assert.fieldEquals("Settlement", id("s2"), "slippageBp", "100");
    // The displayed bp is DERIVED from the tenth-bp figure, never the reverse.
    assert.fieldEquals("Settlement", id("s2"), "slippageTenthBp", "1000");
  });

  test("the arrival anchor is fixed at settledAt, not at the finalize block", () => {
    // The invariant the two-phase write exists to provide. A newer, much higher
    // print lands between open and finalize; the settlement must not see it.
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handleSettlementOpened(settlementOpened("s3", "ACR-INF", BigInt.fromI32(101), 1500, 1510, 2));
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL.times(BigInt.fromI32(2)), 7200, 1550, 3));
    handleSettlementFinalized(settlementFinalized("s3", ONE_UNIT, 1600, 4));

    assert.fieldEquals("Settlement", id("s3"), "arrivalValue", "100000000000000");
    assert.fieldEquals("Settlement", id("s3"), "slippageBp", "100");
  });

  test("a settlement older than every print is unbenchmarked, with a reason", () => {
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 5000, 1));
    handleSettlementOpened(settlementOpened("s4", "ACR-INF", BigInt.fromI32(101), 4000, 5010, 2));
    handleSettlementFinalized(settlementFinalized("s4", ONE_UNIT, 5100, 3));

    assert.fieldEquals("Settlement", id("s4"), "benchmarked", "false");
    assert.fieldEquals("Settlement", id("s4"), "unbenchmarkedReason", "NO_PRINT_YET");
    // Never a silent zero. Asserted through the rollup rather than directly:
    // `fieldEquals` cannot express "this field was never written", and a
    // nullable BigInt cannot be null-compared in AssemblyScript either — BigInt
    // overloads `==`, so `x == null` crashes the compiler exactly as it does
    // for Bytes. What is observable is that nothing was graded.
    const day = sellerDay(5100);
    assert.fieldEquals("SellerDay", day, "n", "0");
    assert.fieldEquals("SellerDay", day, "wSlipTenthBp", "0");
    assert.fieldEquals("PayerDay", payerDay(5100), "n", "0");
    assert.fieldEquals("PayerDay", payerDay(5100), "overpay", "0");
  });

  test("an unbenchmarked settlement fires no histogram bucket", () => {
    // A settlement with no price to compare against must not land in b2 and
    // inflate the "priced fairly" bucket a seller grade is then built on.
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 5000, 1));
    handleSettlementOpened(settlementOpened("s5", "ACR-INF", BigInt.fromI32(101), 4000, 5010, 2));
    handleSettlementFinalized(settlementFinalized("s5", ONE_UNIT, 5100, 3));

    const day = sellerDay(5100);
    assert.fieldEquals("SellerDay", day, "nAll", "1");
    assert.fieldEquals("SellerDay", day, "n", "0");
    assert.fieldEquals("SellerDay", day, "bmVolume", "0");
    assert.fieldEquals("SellerDay", day, "wSlipTenthBp", "0");
    assert.fieldEquals("SellerDay", day, "b2", "0");
    // It still counts as volume — it happened, it just cannot be graded.
    assert.fieldEquals("SellerDay", day, "volume", "101");
  });

  test("exactly one bucket fires, and the buckets sum to n", () => {
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handleSettlementOpened(settlementOpened("s6", "ACR-INF", BigInt.fromI32(101), 1500, 1510, 2));
    handleSettlementFinalized(settlementFinalized("s6", ONE_UNIT, 1600, 3));

    const day = sellerDay(1600);
    // +100 bp lands in b4 ([100, 200)), and nowhere else.
    assert.fieldEquals("SellerDay", day, "b4", "1");
    assert.fieldEquals("SellerDay", day, "b3", "0");
    assert.fieldEquals("SellerDay", day, "b5", "0");
    assert.fieldEquals("SellerDay", day, "n", "1");
    // The identity that fails loudly if a range is ever edited into a gap or
    // an overlap.
    assertBucketsSumToN(day);
  });

  test("a day accumulates across settlements", () => {
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handleSettlementOpened(settlementOpened("sB", "ACR-INF", BigInt.fromI32(101), 1500, 1510, 2));
    handleSettlementFinalized(settlementFinalized("sB", ONE_UNIT, 1600, 3));
    handleSettlementOpened(settlementOpened("sC", "ACR-INF", BigInt.fromI32(100), 1700, 1710, 4));
    handleSettlementFinalized(settlementFinalized("sC", ONE_UNIT, 1800, 5));

    const day = sellerDay(1800);
    assert.fieldEquals("SellerDay", day, "nAll", "2");
    assert.fieldEquals("SellerDay", day, "n", "2");
    assert.fieldEquals("SellerDay", day, "volume", "201");
    assert.fieldEquals("SellerDay", day, "b4", "1"); // the +100bp fill
    assert.fieldEquals("SellerDay", day, "b2", "1"); // the at-arrival fill
    assertBucketsSumToN(day);
    // Volume-weighted slippage: (101 * 1000 + 100 * 0) / 201 / 10 bp.
    assert.fieldEquals("SellerDay", day, "wSlipTenthBp", "101000");
    assert.fieldEquals("SellerDay", day, "bmVolume", "201");
    // Only the fill above arrival contributes overpay: 101 * 1000 / 100000 = 1.
    assert.fieldEquals("PayerDay", payerDay(1800), "overpay", "1");
  });

  test("synthetic volume is split out of real volume, not hidden", () => {
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handleSettlementOpened(settlementOpened("sD", "ACR-INF", BigInt.fromI32(101), 1500, 1510, 2, true));
    handleSettlementFinalized(settlementFinalized("sD", ONE_UNIT, 1600, 3));

    const day = sellerDay(1600);
    assert.fieldEquals("SellerDay", day, "volume", "101");
    assert.fieldEquals("SellerDay", day, "synthVolume", "101");
    assert.fieldEquals("SellerDay", day, "realVolume", "0");
  });

  test("finalize without an open is dropped, not crashed", () => {
    // The contract forbids it; a mapping that aborted would halt indexing on a
    // live subgraph, so the handler has to survive it too.
    handleSettlementFinalized(settlementFinalized("ghost", ONE_UNIT, 1600, 3));
    assert.entityCount("Settlement", 0);
    assert.entityCount("SellerDay", 0);
    assert.entityCount("PayerDay", 0);
  });

  test("a replayed finalize does not double-count the payer", () => {
    // Handlers re-run on reorgs. Double-counted volume is a silent corruption
    // that no query would reveal.
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handleSettlementOpened(settlementOpened("s7", "ACR-INF", BigInt.fromI32(101), 1500, 1510, 2));
    handleSettlementFinalized(settlementFinalized("s7", ONE_UNIT, 1600, 3));
    handleSettlementFinalized(settlementFinalized("s7", ONE_UNIT, 1600, 3));

    assert.fieldEquals("SellerDay", sellerDay(1600), "nAll", "1");
    assert.fieldEquals("Payer", "0x00000000000000000000000000000000000000a1", "settlementCount", "1");
    assert.fieldEquals("Payer", "0x00000000000000000000000000000000000000a1", "totalVolume", "101");
  });

  test("a repeat buyer counts once toward the seller's distinct payers", () => {
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handleSettlementOpened(settlementOpened("s8", "ACR-INF", BigInt.fromI32(101), 1500, 1510, 2));
    handleSettlementFinalized(settlementFinalized("s8", ONE_UNIT, 1600, 3));
    handleSettlementOpened(settlementOpened("s9", "ACR-INF", BigInt.fromI32(101), 1700, 1710, 4));
    handleSettlementFinalized(settlementFinalized("s9", ONE_UNIT, 1800, 5));

    assert.fieldEquals("Seller", "0x00000000000000000000000000000000000000b2", "distinctPayers", "1");
    assert.fieldEquals("Seller", "0x00000000000000000000000000000000000000b2", "settlementCount", "2");
  });

  test("synthetic flow is recorded as synthetic, and stays in the volume", () => {
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handleSettlementOpened(settlementOpened("sA", "ACR-INF", BigInt.fromI32(101), 1500, 1510, 2));
    handleSettlementFinalized(settlementFinalized("sA", ONE_UNIT, 1600, 3));

    assert.fieldEquals("Settlement", id("sA"), "synthetic", "true");
    assert.fieldEquals("SellerDay", sellerDay(1600), "synthVolume", "101");
    assert.fieldEquals("SellerDay", sellerDay(1600), "volume", "101");
  });
});
