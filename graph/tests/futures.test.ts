import { BigInt } from "@graphprotocol/graph-ts";
import { assert, describe, test, clearStore, afterEach } from "matchstick-as";
import { handlePricePosted } from "../src/oracle";
import { handleSeriesOpened, handleTraded } from "../src/futures";
import { pricePosted, seriesOpened, traded, wad, eventId } from "./helpers";

describe("futures fills — the control group", () => {
  afterEach(() => { clearStore(); });

  test("a fill at the prevailing mark measures exactly zero slippage", () => {
    // ACRFutures.trade fills at oracle.latestValue (ACRFutures.sol:244), so the
    // fill price IS the arrival price and shortfall is zero by construction.
    // That makes this a real on-chain fixture whose answer is known in advance:
    // anything other than 0 here means the arrival selection is wrong.
    handlePricePosted(pricePosted("ACR-INF", wad(10), 3600, 1000, 1));
    handleSeriesOpened(seriesOpened(1, "ACR-INF"));
    const fill = traded(1, wad(10), 1500, 2);
    handleTraded(fill);

    const id = eventId(fill);
    assert.fieldEquals("FuturesFill", id, "benchmarked", "true");
    assert.fieldEquals("FuturesFill", id, "slippageBp", "0");
    assert.fieldEquals("FuturesFill", id, "index", "ACR-INF");
  });

  test("a fill before any print is unbenchmarked, not zero", () => {
    handleSeriesOpened(seriesOpened(1, "ACR-INF"));
    const fill = traded(1, wad(10), 1500, 2);
    handleTraded(fill);
    assert.fieldEquals("FuturesFill", eventId(fill), "benchmarked", "false");
  });

  test("a fill above the mark reads positive basis points", () => {
    handlePricePosted(pricePosted("ACR-INF", BigInt.fromI32(10000), 3600, 1000, 1));
    handleSeriesOpened(seriesOpened(1, "ACR-INF"));
    const fill = traded(1, BigInt.fromI32(10100), 1500, 2);
    handleTraded(fill);
    assert.fieldEquals("FuturesFill", eventId(fill), "slippageBp", "100");
  });

  test("the series counts its fills", () => {
    handlePricePosted(pricePosted("ACR-INF", wad(10), 3600, 1000, 1));
    handleSeriesOpened(seriesOpened(1, "ACR-INF"));
    handleTraded(traded(1, wad(10), 1500, 2));
    handleTraded(traded(1, wad(10), 1600, 3));
    assert.fieldEquals("Series", "1", "fillCount", "2");
  });
});
