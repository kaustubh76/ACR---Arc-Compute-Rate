import assert from "node:assert/strict";
import { test } from "node:test";
import { checkHref } from "./checkLink";
import { UNITS } from "./indices";
import type { SpendDecision } from "./types";

/* The rule this encodes is "offer the link only when it would work", and the
 * failure it prevents is specific: `/check` validates its whole query on mount
 * and populates NOTHING from a partial one, so a link missing a unit or a
 * quantity lands a reader on an empty form having just promised them a verdict
 * on this exact bill. That is worse than no link, and it is invisible from the
 * call site -- the href is there, it is well-formed, and it does nothing.
 *
 * It is also not a hypothetical shape. Measured on 112 live fleet receipts:
 * 42 `$/1k tokens`, 12 `$/GPU-sec`, 12 `$/MB`, 6 `$/query` and 40 with no unit
 * at all -- and every decision currently on the press predates the `unit` field
 * entirely, so TODAY this returns null for all nineteen of them. A test is the
 * only way to know the positive path works before that changes.
 */

function row(over: Partial<SpendDecision> = {}): SpendDecision {
  return {
    at: 1_791_000_000,
    obligation_id: "b:0xaa:thing",
    vendor: "0x" + "aa".repeat(20),
    category: "infra",
    billed_usdc: 0.02,
    intent: "escalate",
    rule: "over the going rate",
    unit: "$/1k tokens",
    vendor_quantity: 10,
    ...over,
  };
}

test("a priceable bill gets a link that carries every field /check needs", () => {
  const href = checkHref(row());
  assert.ok(href, "a complete row produced no link");
  const q = new URLSearchParams(href.split("?")[1]);
  assert.equal(q.get("unit"), "$/1k tokens");
  assert.equal(q.get("billed_usdc"), "0.02");
  assert.equal(q.get("quantity"), "10");
  assert.equal(q.get("vendor"), "0x" + "aa".repeat(20));
});

test("every unit the press can price is accepted", () => {
  for (const unit of UNITS) {
    assert.ok(checkHref(row({ unit })), `${unit} was refused`);
  }
});

test("a unit the press cannot price gets no link", () => {
  // `$/query` is real: six live receipts carry it, and `/par` 422s on it. A link
  // would promise a verdict the press refuses to give.
  assert.equal(checkHref(row({ unit: "$/query" })), null);
  assert.equal(checkHref(row({ unit: "per call" })), null);
});

test("a row with no unit gets no link, which is every decision on the press today", () => {
  assert.equal(checkHref(row({ unit: undefined })), null);
  assert.equal(checkHref(row({ unit: "" })), null);
  assert.equal(checkHref(row({ unit: "   " })), null);
});

test("a missing or non-positive quantity gets no link", () => {
  // Without a quantity there is no per-unit price, which is `NO_QUANTITY` in
  // the engine: a whole bill cannot be compared with a rate.
  assert.equal(checkHref(row({ vendor_quantity: null })), null);
  assert.equal(checkHref(row({ vendor_quantity: 0 })), null);
  assert.equal(checkHref(row({ vendor_quantity: -4 })), null);
  assert.equal(checkHref(row({ vendor_quantity: Number.NaN })), null);
});

test("a non-positive bill gets no link", () => {
  assert.equal(checkHref(row({ billed_usdc: 0 })), null);
});

test("it prices WHAT WAS BILLED, not what the meter counted", () => {
  // The owner is being asked to agree with the vendor's number. Whether that
  // number was real is the meter's separate question, and the discrepancy line
  // on the card already answers it -- pricing the metered figure would quietly
  // answer a question nobody asked.
  const href = checkHref(row({ vendor_quantity: 10, metered_quantity: 4 }));
  assert.ok(href);
  assert.equal(new URLSearchParams(href.split("?")[1]).get("quantity"), "10");
});

test("the vendor is optional, and its absence does not void the link", () => {
  const href = checkHref(row({ vendor: "" }));
  assert.ok(href, "a bill with no vendor should still be priceable");
  assert.equal(new URLSearchParams(href.split("?")[1]).get("vendor"), null);
});

test("the unit survives encoding, because $ and / are both significant", () => {
  const href = checkHref(row({ unit: "$/GPU-sec" }));
  assert.ok(href);
  assert.ok(
    href.includes("%24%2FGPU-sec") || href.includes("unit=%24%2FGPU-sec"),
    `the unit was not encoded: ${href}`,
  );
  // And it round-trips: this is the contract /check's own mount effect relies on.
  assert.equal(new URLSearchParams(href.split("?")[1]).get("unit"), "$/GPU-sec");
});
