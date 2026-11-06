import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RESERVE_FUND, RESERVE_RECORD, agreesWithRecord, codeBytes, reserveFund } from "./floatReserve";

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

test("both addresses in the doc are the ones the page would read", () => {
  const doc = readFileSync(TAMEION, "utf8");
  const t = reserveFund("testnet");
  assert.ok(doc.includes(t.token), "the testnet fund address is the recorded one");
  assert.ok(doc.includes(t.teller), "the teller address is the recorded one");
  assert.ok(doc.includes(RESERVE_FUND.mainnet.token), "the mainnet fund address is the recorded one");
  /* THE MAINNET TELLER WAS NEVER READ FIRST-HAND, so there is nothing to put
     here. An invented address would be the one thing this whole module exists
     to avoid: a value on screen nobody checked. */
  assert.equal(RESERVE_FUND.mainnet.teller, "");
});
