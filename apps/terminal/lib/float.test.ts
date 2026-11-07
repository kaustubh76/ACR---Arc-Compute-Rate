import { test } from "node:test";
import assert from "node:assert/strict";

import { countdown, drawSplit, isAgentAddress, premiumPct, statusChip, type FloatStatus, wrongChain } from "./float";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT_SOL = join(HERE, "..", "..", "..", "contracts", "src", "float", "FloatVault.sol");

/* The four helpers every float surface renders through, which had no test.

   Each one encodes a decision the module's own comments argue for, and each of
   those decisions is the kind that survives a refactor only if something
   asserts it: an absent premium that must read as an ellipsis and not as zero,
   a chip tier per outcome, a countdown that floors rather than going negative,
   and an address check that is deliberately looser than a checksum. */

test("a premium is a percentage over the chain's own fair price", () => {
  assert.equal(premiumPct({ quote_usdc: 18, fair_usdc: 17.4 })?.toFixed(1), "3.4");
  assert.equal(premiumPct({ quote_usdc: 10, fair_usdc: 10 }), 0);
  // the contract's premiumBps is int256: a quote below fair is legal
  assert.ok(premiumPct({ quote_usdc: 9, fair_usdc: 10 })! < 0);
  assert.equal(premiumPct({ quote_usdc: 30, fair_usdc: 10 }), 200);
});

test("no fair price is null, which renders as an ellipsis and never as zero", () => {
  /* The distinction the module argues for: a zero premium means "priced exactly
     at fair", which is a real and good answer. Folding "we have no print to
     compare against" into it would print the best possible verdict on the one
     case where nothing is known. */
  assert.equal(premiumPct({ quote_usdc: 18, fair_usdc: 0 }), null);
  assert.equal(premiumPct({ quote_usdc: 18, fair_usdc: -1 }), null);
  assert.equal(premiumPct({ quote_usdc: 18, fair_usdc: Number.NaN }), null);
  assert.equal(premiumPct({ quote_usdc: Number.NaN, fair_usdc: 17.4 }), null);
});

test("every outcome the press can send has a chip tier, and they differ by meaning", () => {
  const tiers: Record<FloatStatus, string> = {
    consumed: "chip-teal",
    open: "chip-sky",
    claimed: "chip-sky",
    denied: "chip-breach",
    failed: "chip-breach",
    expired: "chip-sim",
  };
  for (const [status, chip] of Object.entries(tiers)) {
    assert.equal(statusChip(status as FloatStatus), chip, `${status} should be ${chip}`);
  }
  /* A paid payment and a refused one must never share a colour, and a window
     that merely closed is neither: nobody refused it. */
  assert.notEqual(statusChip("consumed"), statusChip("denied"));
  assert.notEqual(statusChip("expired"), statusChip("denied"));
  assert.notEqual(statusChip("open"), statusChip("consumed"));
});

test("the countdown floors at zero and keeps two digits of seconds", () => {
  assert.equal(countdown(300), "5:00");
  assert.equal(countdown(299), "4:59");
  assert.equal(countdown(61), "1:01");
  assert.equal(countdown(9), "0:09");
  assert.equal(countdown(0), "0:00");
  /* A negative duration is what a clock that has run past its deadline
     produces, and "-1:-1" on an approval card would read as a bug rather than
     as an expiry. */
  assert.equal(countdown(-5), "0:00");
  assert.equal(countdown(0.9), "0:00");
  // above an hour it still reads as minutes rather than wrapping
  assert.equal(countdown(3_661), "61:01");
});

test("an agent address is checked for shape, not for checksum", () => {
  /* The module's reason, verbatim: a visitor pasting from a block explorer gets
     mixed case and a visitor typing gets lower, and refusing the second would be
     refusing the commoner case. */
  assert.ok(isAgentAddress("0x64E21e01e7D9Abfd4C32cfaC4F590B24ECf38d16"));
  assert.ok(isAgentAddress("0x64e21e01e7d9abfd4c32cfac4f590b24ecf38d16"));
  assert.ok(isAgentAddress("  0x64e21e01e7d9abfd4c32cfac4f590b24ecf38d16  "));
  assert.ok(!isAgentAddress("64e21e01e7d9abfd4c32cfac4f590b24ecf38d16"));
  assert.ok(!isAgentAddress("0x64e21e01e7d9abfd4c32cfac4f590b24ecf38d1"));
  assert.ok(!isAgentAddress("0x64e21e01e7d9abfd4c32cfac4f590b24ecf38d160"));
  assert.ok(!isAgentAddress("0xZZZ1e01e7d9abfd4c32cfac4f590b24ecf38d16"));
  assert.ok(!isAgentAddress(""));
});

test("a chain that would not answer is not a chain the reader is on the wrong side of", () => {
  /* `status: "pending"` means two unrelated things and only one of them has a
     network to switch to. `/float` branched on the status alone and showed
     "NOT ON THIS CHAIN. Switch the network" — with no button, because there was
     nothing to switch to — to a reader on the correct chain whose only problem
     was a rate limit. Witnessed on a freshly started server while the route
     answered `status: "ok"` seconds later. */

  /* The genuine case: the config refused AND named somewhere to go. */
  assert.equal(wrongChain({ status: "pending", switch_to: "testnet" }), true);
  assert.equal(wrongChain({ status: "pending", switch_to: "mainnet" }), true);

  /* THE CASE THAT WAS WRONG. Both of these are "the chain did not answer", and
     neither is the reader's fault; they must fall through to the unreachable
     copy, which already says it retries by itself. */
  assert.equal(wrongChain({ status: "pending" }), false, "rate limited is not wrong-chain");
  assert.equal(wrongChain({ status: "pending", switch_to: undefined }), false);

  /* A healthy read is not pending at all, whatever else it carries. */
  assert.equal(wrongChain({ status: "ok" }), false);
  assert.equal(wrongChain({ status: "ok", switch_to: "testnet" }), false, "ok outranks a stale hint");

  /* Nothing asked yet is not an answer about chains. */
  assert.equal(wrongChain(null), false);
  assert.equal(wrongChain(undefined), false);
});

test("a draw inside the buffer never touches a sleeve", () => {
  const s = drawSplit(0.4, 0.5, 9.5, 0);
  assert.deepEqual(s, { want: 0.4, fromBuffer: 0.4, fromWorking: 0, fromReserve: 0 });
  /* Exactly the buffer is still the buffer's own, which is the boundary the
     contract expresses as `bal >= need` returning before it touches anything. */
  assert.deepEqual(drawSplit(0.5, 0.5, 9.5, 0), { want: 0.5, fromBuffer: 0.5, fromWorking: 0, fromReserve: 0 });
});

test("the working sleeve covers the shortfall alone while it can, and the reserve gets nothing", () => {
  const s = drawSplit(5, 0.5, 9.5, 4);
  assert.equal(s.fromBuffer, 0.5);
  assert.equal(s.fromWorking, 4.5);
  /* THE CLAMP. `shortfall - working` is negative here, and without the floor at
     zero a covered shortfall would bleed into the reserve. The contract says the
     same thing as `held < need`. */
  assert.equal(s.fromReserve, 0);
});

test("past both the buffer and the working sleeve it splits across all three", () => {
  /* THE BRANCH PRODUCTION HAS NEVER REACHED. The reserve ships as a null sleeve,
     so this is the first and only place the two-sleeve split is exercised. */
  const s = drawSplit(12, 0.5, 9.5, 4);
  assert.equal(s.fromBuffer, 0.5);
  assert.equal(s.fromWorking, 9.5, "the working sleeve is drained first, and fully");
  assert.equal(s.fromReserve, 2, "and only the remainder reaches the reserve");
  assert.equal(s.fromBuffer + s.fromWorking + s.fromReserve, s.want);

  /* Exactly buffer + working takes nothing from the reserve: the boundary. */
  const edge = drawSplit(10, 0.5, 9.5, 4);
  assert.deepEqual(edge, { want: 10, fromBuffer: 0.5, fromWorking: 9.5, fromReserve: 0 });
});

test("a sleeve that is not live contributes nothing, which is what keeps the slider inert", () => {
  /* The live shape today: reserve null, so 0. The ceiling must be buffer plus
     working exactly, and the reserve must never receive anything however far
     the draw is pushed. */
  const s = drawSplit(1e9, 0.5, 9.5, 0);
  assert.equal(s.want, 10, "the ceiling excludes a sleeve that is not there");
  assert.equal(s.fromReserve, 0);
  assert.equal(s.fromBuffer + s.fromWorking, 10);

  /* And with no sleeves at all, the buffer is the whole ceiling. */
  assert.deepEqual(drawSplit(5, 2, 0, 0), { want: 2, fromBuffer: 2, fromWorking: 0, fromReserve: 0 });
});

test("the parts always sum to the draw, and the draw never exceeds what is there", () => {
  for (const [d, b, w, r] of [
    [0, 0.5, 9.5, 4], [0.25, 0.5, 9.5, 4], [7.3, 0.5, 9.5, 4], [10.000001, 0.5, 9.5, 4],
    [13.9, 0.5, 9.5, 4], [14, 0.5, 9.5, 4], [99, 0.5, 9.5, 4], [-5, 0.5, 9.5, 4],
  ] as const) {
    const s = drawSplit(d, b, w, r);
    const sum = s.fromBuffer + s.fromWorking + s.fromReserve;
    assert.ok(Math.abs(sum - s.want) < 1e-9, `parts ${sum} should sum to want ${s.want} for draw ${d}`);
    assert.ok(s.want <= b + w + r + 1e-9, `want ${s.want} should not exceed the ceiling for draw ${d}`);
    assert.ok(s.want >= 0, "a negative draw is not a negative payment");
  }
});

test("the port still matches the order FloatVault._fund pulls in", () => {
  /* A DRIFT GUARD, not a restatement. If the contract ever drains the reserve
     before the working sleeve, this port is wrong and the meter would narrate
     the wrong order to a reader with nothing complaining. Read out of the source
     the way `floatAbi.test.ts` drives the ABIs. */
  const src = readFileSync(VAULT_SOL, "utf8");
  const fund = src.slice(src.indexOf("function _fund("));
  const body = fund.slice(0, fund.indexOf("\n    }"));
  const w = body.indexOf("working.withdrawExact");
  const r = body.indexOf("reserve.withdrawExact");
  assert.ok(w > 0, "_fund no longer withdraws from the working sleeve");
  assert.ok(r > 0, "_fund no longer withdraws from the reserve");
  assert.ok(w < r, "_fund drains the working sleeve before the reserve, and drawSplit assumes it");
  /* The cap the port mirrors: the working pull is bounded by its own value. */
  assert.match(body, /valueUsdc\(\)/);
});
