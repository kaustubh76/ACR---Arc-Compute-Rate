import { BigInt } from "@graphprotocol/graph-ts";
import { assert, describe, test, clearStore, afterEach } from "matchstick-as";
import { handlePricePosted, handlePricePostedV2 } from "../src/oracle";
import { handleSettlementOpened, handleSettlementFinalized } from "../src/mirror";
import { loadRing, pickArrival } from "../src/tca";
import {
  pricePosted, pricePostedV2, settlementOpened, settlementFinalized, sidBytes, wad,
} from "./helpers";

const ARRIVAL = BigInt.fromString("100000000000000");
const ONE_UNIT = BigInt.fromString("1000000000000000000");

function sid(label: string): string {
  return sidBytes(label).toHexString();
}

describe("two oracles, one economic print", () => {
  afterEach(() => { clearStore(); });

  test("the second oracle's posting does not push a second ring slot", () => {
    // v1 posts the hour at block time 1000; v2 mirrors the SAME economic print
    // at 1060. They are one print, not two — collapsing them is what keeps the
    // ring's usable depth from halving during the overlap.
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handlePricePostedV2(pricePostedV2("ACR-INF", ARRIVAL, 3600, 1060, 2));

    const ring = loadRing("ACR-INF");
    assert.i32Equals(1, ring.printIds.length);
    assert.entityCount("EconomicPrint", 1);
    // Both postings survive independently — each has its own tx to audit.
    assert.entityCount("Print", 2);
  });

  test("the arrival anchor stays the FIRST posting's block time", () => {
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handlePricePostedV2(pricePostedV2("ACR-INF", ARRIVAL, 3600, 1060, 2));

    const ring = loadRing("ACR-INF");
    assert.bigIntEquals(BigInt.fromI32(1000), ring.postedAts[0]);
    assert.fieldEquals("EconomicPrint", "ACR-INF-3600", "postedAt", "1000");
  });

  test("a settlement between the two postings is still benchmarked against that hour", () => {
    // The bug this whole layer exists to prevent: if v2's later postedAt
    // replaced v1's, a payer who settled at 1030 would fall through to the
    // PREVIOUS hour's print — moved by a deployment choice, not by the market.
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handlePricePostedV2(pricePostedV2("ACR-INF", ARRIVAL, 3600, 1060, 2));

    handleSettlementOpened(settlementOpened("s1", "ACR-INF", BigInt.fromI32(101), 1030, 1040, 3));
    handleSettlementFinalized(settlementFinalized("s1", ONE_UNIT, 1100, 4));

    assert.fieldEquals("Settlement", sid("s1"), "benchmarked", "true");
    assert.fieldEquals("Settlement", sid("s1"), "arrivalValue", "100000000000000");
    assert.fieldEquals("Settlement", sid("s1"), "slippageBp", "100");
  });

  test("v2's extra fields are added to the shared print, not lost", () => {
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handlePricePostedV2(pricePostedV2("ACR-INF", ARRIVAL, 3600, 1060, 2));

    // v1 posted first, so the pricing fields are its — but the policy and
    // window only v2 carries are now on the record.
    assert.fieldEquals("EconomicPrint", "ACR-INF-3600", "oracleMask", "3");
    assert.fieldEquals("EconomicPrint", "ACR-INF-3600", "windowEnd", "3600");
    assert.fieldEquals("EconomicPrint", "ACR-INF-3600", "windowStart", "0");
    assert.fieldEquals("EconomicPrint", "ACR-INF-3600", "divergent", "false");
  });

  test("a zero human bound is recorded as absent, not as free", () => {
    handlePricePostedV2(pricePostedV2("ACR-INF", ARRIVAL, 3600, 1000, 1));
    // The contract's sentinel for "not computed". Stored null so no reader can
    // render it as "attacking through humans costs nothing".
    assert.fieldEquals("EconomicPrint", "ACR-INF-3600", "humanAdjustedBound", "null");
  });

  test("a real human bound is kept", () => {
    handlePricePostedV2(
      pricePostedV2("ACR-INF", ARRIVAL, 3600, 1000, 1, "acr.cleaning.v1", BigInt.fromI32(9999))
    );
    assert.fieldEquals("EconomicPrint", "ACR-INF-3600", "humanAdjustedBound", "9999");
  });

  test("two oracles disagreeing on the same print is recorded, not resolved", () => {
    // The only automatic detector for a mis-scaled v2 payload. Picking a winner
    // would hide precisely the thing worth seeing.
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handlePricePostedV2(pricePostedV2("ACR-INF", ARRIVAL.times(BigInt.fromI32(2)), 3600, 1060, 2));

    assert.fieldEquals("EconomicPrint", "ACR-INF-3600", "divergent", "true");
    // The first posting's value stands; the disagreement is a flag beside it.
    assert.fieldEquals("EconomicPrint", "ACR-INF-3600", "value", "100000000000000");
  });

  test("a genuinely new hour still pushes a slot", () => {
    handlePricePosted(pricePosted("ACR-INF", ARRIVAL, 3600, 1000, 1));
    handlePricePostedV2(pricePostedV2("ACR-INF", ARRIVAL, 3600, 1060, 2));
    handlePricePostedV2(pricePostedV2("ACR-INF", ARRIVAL, 7200, 4600, 3));

    const ring = loadRing("ACR-INF");
    assert.i32Equals(2, ring.printIds.length);
    assert.i32Equals(0, pickArrival(ring, BigInt.fromI32(5000)));
  });

  test("v2 alone works — after the overlap ends", () => {
    handlePricePostedV2(pricePostedV2("ACR-INF", ARRIVAL, 3600, 1000, 1));
    const ring = loadRing("ACR-INF");
    assert.i32Equals(1, ring.printIds.length);
    assert.fieldEquals("EconomicPrint", "ACR-INF-3600", "oracleMask", "2");
    assert.fieldEquals("Print", ring.printIds[0].toHexString(), "oracleVersion", "2");
  });
});
