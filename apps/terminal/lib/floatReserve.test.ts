import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESERVE_FUND,
  RESERVE_RECORD,
  agreesWithRecord,
  codeBytes,
  refusalName,
  reserveFund,
  reserveShareBps,
  slotIsEmpty,
  revertSelector,
} from "./floatReserve";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAMEION = join(HERE, "..", "..", "..", "docs", "TAMEION.md");

/* The reserve fund, pinned to the document that recorded it.
 *
 * Both functions here exist to stop the panel saying something alarming it has
 * not earned, and both are one branch away from doing exactly that. */

test("nothing deployed is 0 bytes, and 0 is a readable answer", () => {
  /* THE WHOLE POINT. The panel claims these contracts are real; a function
     that cannot return "nothing is there" cannot honestly return "something
     is there" either. A node answers `0x` or nothing at all for an address
     with no code, and both have to land on zero. */
  assert.equal(codeBytes("0x"), 0);
  assert.equal(codeBytes(undefined), 0);
  assert.equal(codeBytes(null), 0);
  assert.equal(codeBytes(""), 0);
  /* Two hex characters a byte, minus the `0x`. The recorded proxy is 183. */
  assert.equal(codeBytes("0x" + "ab".repeat(183)), 183);
  assert.equal(codeBytes("0xab"), 1);
});

test("a throttled read is not a disagreement with the record", () => {
  /* "The fund no longer matches our record" is the most alarming sentence this
     panel can print. It must come from two reads that both arrived and
     disagreed, never from one that did not arrive. */
  assert.equal(agreesWithRecord(null, 6), null);
  assert.equal(agreesWithRecord("USYC", null), null);
  assert.equal(agreesWithRecord(null, null), null);

  assert.equal(agreesWithRecord("USYC", 6), true);
  assert.equal(agreesWithRecord("USDC", 6), false, "a different fund is a disagreement");
  assert.equal(agreesWithRecord("USYC", 18), false, "a re-scaled token is a disagreement");
});

test("the record is the one in docs/TAMEION.md, not a second copy of it", () => {
  /* A constant that drifts from the document it cites is worse than no
     constant: the page would compare live reads against a number nobody wrote
     down. Driven out of the prose so the two cannot disagree silently. */
  const doc = readFileSync(TAMEION, "utf8");
  assert.match(doc, new RegExp(`symbol\\(\\) == "${RESERVE_RECORD.symbol}"`));
  assert.match(doc, new RegExp(`decimals\\(\\) == ${RESERVE_RECORD.decimals}`));
});

test("the map holds well-formed addresses, one fund per chain, anchored to the doc's own labels", () => {
  /* A PROPERTY TEST RATHER THAN A LIST OF EXPECTED VALUES, because the shape of
     the mistake this map invites is not a typo — it is an address pasted under
     the wrong `ChainKey`. The first version of this test asserted that both
     addresses appear somewhere in `docs/TAMEION.md`, which a straight SWAP of
     the two entries passes: both are still in the document. So the mainnet
     entry is anchored to the sentence that calls it mainnet, and the rule below
     holds for a third chain added later, which an expected list would not. */
  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  const doc = readFileSync(TAMEION, "utf8");

  const tokens = new Set<string>();
  for (const [chain, fund] of Object.entries(RESERVE_FUND)) {
    /* The accessor the reader actually calls, checked against the map rather
       than assumed to be a pass-through: `readReserveFacts` reaches the fund
       only through this, so a wrong key here would be invisible above. */
    assert.deepEqual(reserveFund(chain as "testnet" | "mainnet"), fund, `reserveFund("${chain}") is not its own entry`);
    assert.match(fund.token, ADDR, `${chain} fund address is not 20 bytes`);
    assert.ok(!tokens.has(fund.token.toLowerCase()), `${chain} reuses another chain's fund address`);
    tokens.add(fund.token.toLowerCase());
    /* Blank is allowed and meaningful; anything non-blank must be real. A
       half-typed address is the one state that must not survive. */
    if (fund.teller !== "") {
      assert.match(fund.teller, ADDR, `${chain} teller address is not 20 bytes`);
      assert.notEqual(fund.teller.toLowerCase(), fund.token.toLowerCase(), `${chain} teller is its own token`);
    }
  }

  /* THE ANCHORS. Each one is the address the document itself LABELS, so a swap
     between the two chains fails here rather than passing a presence check. */
  const mainnetDoc = /Mainnet USYC is\s*`(0x[0-9a-fA-F]{40})`/.exec(doc);
  assert.ok(mainnetDoc, "docs/TAMEION.md no longer names the mainnet fund");
  assert.equal(RESERVE_FUND.mainnet.token.toLowerCase(), mainnetDoc[1].toLowerCase());

  const tellerDoc = /Teller that mints and redeems it,\s*`(0x[0-9a-fA-F]{40})`/.exec(doc);
  assert.ok(tellerDoc, "docs/TAMEION.md no longer names the teller");
  assert.equal(RESERVE_FUND.testnet.teller.toLowerCase(), tellerDoc[1].toLowerCase());

  /* And the testnet fund is in the document but is NOT the one it calls
     mainnet, which is the swap this test exists to catch. */
  assert.ok(doc.includes(RESERVE_FUND.testnet.token), "the testnet fund address is not the recorded one");
  assert.notEqual(RESERVE_FUND.testnet.token.toLowerCase(), mainnetDoc[1].toLowerCase());

  /* THE MAINNET TELLER WAS NEVER READ FIRST-HAND, so there is nothing to put
     there. An address that looks plausible is strictly worse than a blank one:
     a blank fails loudly at the first read, a wrong one fails quietly at the
     worst possible moment. */
  assert.equal(RESERVE_FUND.mainnet.teller, "");
});

test("the revert selector is on the innermost cause, not the message", () => {
  /* THE TRAP, REPRODUCED. viem wraps a reverted call
     `CallExecutionError <- ExecutionRevertedError <- RpcRequestError` and only
     the innermost link carries `.data`. A check written against `.message` or
     `.details` reports "no legible answer" about a chain that answered
     perfectly clearly, which is the failure this shape exists to prevent. */
  const wrapped = {
    message: "The contract function reverted.",
    details: "execution reverted",
    cause: { message: "execution reverted", cause: { data: "0x7f63bd0f" } },
  };
  assert.equal(revertSelector(wrapped), "0x7f63bd0f");
  assert.equal(refusalName(revertSelector(wrapped)), "NotPermissioned");

  /* A selector nobody has matched renders as its own hex, which a reader can
     look up, rather than as a name this code invented. */
  assert.equal(refusalName("0xdeadbeef"), "0xdeadbeef");

  /* Longer payloads keep only the selector; revert data carries arguments. */
  assert.equal(revertSelector({ cause: { data: "0x7f63bd0f" + "00".repeat(32) } }), "0x7f63bd0f");
  /* Case from a node that shouts. */
  assert.equal(revertSelector({ cause: { data: "0x7F63BD0F" } }), "0x7f63bd0f");
});

test("nothing legible is null, and null never becomes a refusal name", () => {
  /* An error with no revert data at all — a transport failure, a timeout, a
     rate limit — must not be reported as the fund refusing us. That would
     invent the one sentence this probe is careful about. */
  assert.equal(revertSelector({ message: "fetch failed" }), null);
  assert.equal(revertSelector({ cause: { cause: { cause: {} } } }), null);
  assert.equal(revertSelector(undefined), null);
  assert.equal(revertSelector("0x7f63bd0f"), null, "a bare string is not an error object");
  assert.equal(refusalName(null), null);
  /* `data` that is not a selector is not a selector. */
  assert.equal(revertSelector({ cause: { data: "0x" } }), null);
  assert.equal(revertSelector({ cause: { data: 12345 } }), null);
});

test("only twenty zero bytes reads as an empty slot", () => {
  const ZERO = "0x" + "0".repeat(40);
  assert.equal(slotIsEmpty(ZERO), true);

  /* THE NEGATIVE CASES ARE THE POINT. "No venue, which is the honest answer"
     is reassuring, so it must never be printed for an address that is merely
     zero-ish. Anything malformed drives the cautious branch instead. */
  assert.equal(slotIsEmpty("0x0"), false, "short is not empty");
  assert.equal(slotIsEmpty("0x" + "0".repeat(39)), false, "one byte short is not empty");
  assert.equal(slotIsEmpty("0x" + "0".repeat(41)), false, "one over is not empty");
  assert.equal(slotIsEmpty("0x" + "0".repeat(39) + "1"), false, "a venue is a venue");
  assert.equal(slotIsEmpty("0xdBeCAE19B2A082B51FC4f0dF59cBFfd1cB12ad14"), false);
  assert.equal(slotIsEmpty(undefined), false, "not read is not empty");
  assert.equal(slotIsEmpty(null), false);
  assert.equal(slotIsEmpty(""), false);
  assert.equal(slotIsEmpty("0".repeat(40)), false, "a missing 0x prefix is malformed");
});

test("the reserve's share of a sweep is the remainder, and 10000 leaves it nothing", () => {
  /* `rebalance` does `toWorking = excess * workingShareBps / 10_000` and then
     `toReserve = excess - toWorking`, so the reserve's share is exactly what
     the working sleeve did not take. The live vault sits at 10000. */
  assert.equal(reserveShareBps(10_000), 0, "100% to working leaves the T-bill leg nothing");
  assert.equal(reserveShareBps(0), 10_000);
  assert.equal(reserveShareBps(7_500), 2_500);
  assert.equal(reserveShareBps(9_999), 1);

  /* `setPolicy` guards this, so a stored value cannot exceed 10000 — but a
     negative percentage on screen is a worse answer than a clamped one. */
  assert.equal(reserveShareBps(12_000), 0);
  assert.equal(reserveShareBps(-5), 10_000);

  /* Not read is not zero. An unread policy rendering as "0% reaches the
     reserve" would be a confident claim about a number nobody fetched. */
  assert.equal(reserveShareBps(undefined), null);
  assert.equal(reserveShareBps(null), null);
  assert.equal(reserveShareBps(Number.NaN), null);
});
