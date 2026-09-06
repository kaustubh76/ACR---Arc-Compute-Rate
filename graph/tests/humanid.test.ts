import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { assert, describe, test, clearStore, afterEach } from "matchstick-as";
import { handlePricePosted } from "../src/oracle";
import { handleSettlementOpened, handleSettlementFinalized } from "../src/mirror";
import { handleHumanClusterResolved, handleHumanClusterRebound } from "../src/humanid";
import {
  pricePosted,
  settlementOpened,
  settlementFinalized,
  humanClusterResolved,
  humanClusterRebound,
  sidBytes,
  PAYER,
  SELLER,
} from "./helpers";

// $0.0001 per unit, in the WAD 1e18 scale prints are published in.
const ARRIVAL = BigInt.fromString("100000000000000");
const ONE_UNIT = BigInt.fromString("1000000000000000000"); // WAD 1e18

/** Must equal HumanIdMirror.RATING_WINDOW and src/parties.ts RATING_WINDOW. */
const WINDOW = 604800;
/** A real epoch clock, so the window index is not the degenerate zero. */
const T0 = 1785000000;
const W0 = T0 / WINDOW;

const PAYER_B = Address.fromString("0x00000000000000000000000000000000000000c3");
const ZERO32 = Bytes.fromHexString(
  "0x0000000000000000000000000000000000000000000000000000000000000000"
);

function id(label: string): string {
  return sidBytes(label).toHexString();
}

function sellerWindow(window: i32): string {
  return SELLER.toHexString() + "-" + window.toString();
}

/** Seed a print, then settle one unit at exactly the arrival price. */
function settleOneUnit(label: string, payerTs: i32, logBase: i32): void {
  handlePricePosted(pricePosted("ACR-INF", ARRIVAL, payerTs - 200, payerTs - 100, logBase));
  handleSettlementOpened(
    settlementOpened(label, "ACR-INF", BigInt.fromI32(100), payerTs, payerTs + 10, logBase + 1)
  );
  handleSettlementFinalized(settlementFinalized(label, ONE_UNIT, payerTs + 20, logBase + 2));
}

describe("human clusters", () => {
  afterEach(() => {
    clearStore();
  });

  test("a resolution records the cluster and its window", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));

    assert.fieldEquals("Payer", PAYER.toHexString(), "cluster", id("h1"));
    assert.fieldEquals("Payer", PAYER.toHexString(), "clusterWindow", W0.toString());
    assert.fieldEquals("Payer", PAYER.toHexString(), "resolvedLate", "false");
    assert.fieldEquals("HumanCluster", id("h1"), "walletCount", "1");
    assert.fieldEquals("HumanCluster", id("h1"), "window", W0.toString());
  });

  test("a settlement after resolution is stamped human", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));
    settleOneUnit("s1", T0 + 1000, 2);

    assert.fieldEquals("Settlement", id("s1"), "human", "true");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "distinctHumans", "1");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "distinctPayers", "1");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "humanVolume", "100");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "volume", "100");
  });

  /**
   * THE ordering bug this design exists to make visible.
   *
   * `Settlement` is immutable, so a resolution arriving afterwards cannot go back
   * and stamp it. The count is NOT repaired — repairing it while the rollups it
   * must agree with cannot be repaired would leave two published numbers
   * contradicting each other. It is flagged instead, and the operator runbook
   * says resolve BEFORE generating tape.
   */
  test("a settlement BEFORE resolution stays non-human, and the payer is flagged", () => {
    settleOneUnit("s1", T0 + 1000, 1);
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0 + 2000, 4));

    assert.fieldEquals("Settlement", id("s1"), "human", "false");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "distinctHumans", "0");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "humanVolume", "0");
    // The flag is the whole point: the number is wrong and says so.
    assert.fieldEquals("Payer", PAYER.toHexString(), "resolvedLate", "true");
  });

  /**
   * Rotation is the privacy property. A cluster minted for one window must not
   * keep a payer looking human-backed in the next one, or the identifier would be
   * durable in effect even though it changes on paper.
   */
  test("a cluster from the previous window does not carry into the next", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));
    settleOneUnit("s1", T0 + WINDOW + 1000, 2);

    assert.fieldEquals("Settlement", id("s1"), "human", "false");
    assert.fieldEquals("SellerWindow", sellerWindow(W0 + 1), "distinctHumans", "0");
    assert.fieldEquals("SellerWindow", sellerWindow(W0 + 1), "distinctPayers", "1");
  });

  test("re-resolving in the next window makes the payer human again", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));
    handleHumanClusterResolved(humanClusterResolved("h2", PAYER, W0 + 1, T0 + WINDOW, 2));
    settleOneUnit("s1", T0 + WINDOW + 1000, 3);

    assert.fieldEquals("Settlement", id("s1"), "human", "true");
    assert.fieldEquals("SellerWindow", sellerWindow(W0 + 1), "distinctHumans", "1");
    // Last window's cluster keeps its own count — history is not rewritten.
    assert.fieldEquals("HumanCluster", id("h1"), "walletCount", "1");
    assert.fieldEquals("HumanCluster", id("h2"), "walletCount", "1");
  });

  /**
   * The fleet case, and the reason distinct HUMANS is not distinct PAYERS: two
   * wallets, one person, and a seller that has met one human — not two.
   */
  test("two wallets in one cluster count as one human", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER_B, W0, T0, 2));
    settleOneUnit("s1", T0 + 1000, 3);
    // The SECOND wallet settles — otherwise this proves nothing about counting a
    // fleet once, only about counting one wallet once.
    handleSettlementOpened(
      settlementOpened("s2", "ACR-INF", BigInt.fromI32(100), T0 + 1100, T0 + 1110, 7, true, false, PAYER_B)
    );
    handleSettlementFinalized(settlementFinalized("s2", ONE_UNIT, T0 + 1120, 8, PAYER_B));

    assert.fieldEquals("HumanCluster", id("h1"), "walletCount", "2");
    // Two payers, one human: the distinction the whole component rests on.
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "distinctPayers", "2");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "distinctHumans", "1");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "humanVolume", "200");
  });

  test("a replayed resolution does not double-count the cluster's wallets", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));

    assert.fieldEquals("HumanCluster", id("h1"), "walletCount", "1");
  });

  test("an owner rebind moves the wallet between clusters", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));
    // The target must be a cluster some resolution established — a rebind
    // carries no provenance, so the handler loads and never invents one.
    handleHumanClusterResolved(humanClusterResolved("h2", PAYER_B, W0, T0, 2));
    handleHumanClusterRebound(
      humanClusterRebound(PAYER, W0, "h1", sidBytes("h2"), T0 + 100, 3)
    );

    assert.fieldEquals("Payer", PAYER.toHexString(), "cluster", id("h2"));
    assert.fieldEquals("HumanCluster", id("h1"), "walletCount", "0");
    // h2 already held PAYER_B, and now holds PAYER too.
    assert.fieldEquals("HumanCluster", id("h2"), "walletCount", "2");
  });

  test("a rebind into an unrecorded cluster changes nothing", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));
    handleHumanClusterRebound(
      humanClusterRebound(PAYER, W0, "h1", sidBytes("ghost"), T0 + 100, 2)
    );

    // The contract refuses these, so reaching here means the log is ahead of the
    // store — and guessing a provenance is worse than declining to move.
    assert.entityCount("HumanCluster", 1);
    assert.fieldEquals("Payer", PAYER.toHexString(), "cluster", id("h1"));
  });

  // --- provenance ---

  test("a resolution records whether the human is a sandbox identity", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));
    assert.fieldEquals("HumanCluster", id("h1"), "sandbox", "true");
  });

  test("an orb-verified human is recorded as not sandbox", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1, false));
    assert.fieldEquals("HumanCluster", id("h1"), "sandbox", "false");
  });

  /**
   * The count and its provenance travel together. A human count without the
   * sandbox share would be the same overclaim the synthetic share exists to
   * prevent on the flow side.
   */
  test("the seller window counts sandbox humans alongside the total", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));
    settleOneUnit("s1", T0 + 1000, 2);

    assert.fieldEquals("SellerWindow", sellerWindow(W0), "distinctHumans", "1");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "sandboxHumans", "1");
  });

  test("an orb-verified human does not raise the sandbox count", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1, false));
    settleOneUnit("s1", T0 + 1000, 2);

    assert.fieldEquals("SellerWindow", sellerWindow(W0), "distinctHumans", "1");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "sandboxHumans", "0");
  });

  test("rebinding to zero clears the resolution", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));
    handleHumanClusterRebound(humanClusterRebound(PAYER, W0, "h1", ZERO32, T0 + 100, 2));
    settleOneUnit("s1", T0 + 1000, 3);

    assert.fieldEquals("HumanCluster", id("h1"), "walletCount", "0");
    assert.fieldEquals("Settlement", id("s1"), "human", "false");
  });

  /**
   * A correction aimed at a window the payer has already rotated out of cannot
   * move a field that stopped describing that window. It stays on chain and
   * stays queryable there.
   */
  test("a rebind for a stale window leaves the current one alone", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));
    handleHumanClusterResolved(humanClusterResolved("h2", PAYER, W0 + 1, T0 + WINDOW, 2));
    handleHumanClusterRebound(
      humanClusterRebound(PAYER, W0, "h1", sidBytes("h3"), T0 + WINDOW + 100, 3)
    );

    assert.fieldEquals("Payer", PAYER.toHexString(), "cluster", id("h2"));
    assert.fieldEquals("Payer", PAYER.toHexString(), "clusterWindow", (W0 + 1).toString());
  });

  test("an unresolved payer still counts toward distinct payers and volume", () => {
    settleOneUnit("s1", T0 + 1000, 1);

    assert.fieldEquals("SellerWindow", sellerWindow(W0), "distinctPayers", "1");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "distinctHumans", "0");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "volume", "100");
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "humanVolume", "0");
  });

  test("the window index is derived from the rating window", () => {
    handleHumanClusterResolved(humanClusterResolved("h1", PAYER, W0, T0, 1));
    settleOneUnit("s1", T0 + 1000, 2);

    // The settlement's window must be the one the resolution was minted for, or
    // every payer silently reads as non-human.
    assert.fieldEquals("SellerWindow", sellerWindow(W0), "windowStart", (W0 * WINDOW).toString());
  });
});
