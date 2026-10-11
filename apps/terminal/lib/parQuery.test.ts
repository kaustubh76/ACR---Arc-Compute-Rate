import { test } from "node:test";
import assert from "node:assert/strict";
import { fromRecord, parPath, parSearch, parseParQuery } from "./parQuery";

const get = (o: Record<string, string>) => (k: string) => o[k] ?? null;

test("a complete bill parses, with the vendor optional", () => {
  const r = parseParQuery(get({ unit: "$/1k tokens", billed_usdc: "0.02", quantity: "10" }));
  assert.ok(r.ok);
  assert.deepEqual(r.q, { unit: "$/1k tokens", billed: 0.02, quantity: 10, vendor: "" });
});

test("each refusal names the field that was wrong", () => {
  const bad = (o: Record<string, string>) => {
    const r = parseParQuery(get(o));
    assert.ok(!r.ok);
    return r.error;
  };
  assert.match(bad({ unit: "$/hour", billed_usdc: "1", quantity: "1" }), /^unit/);
  assert.match(bad({ unit: "$/MB", billed_usdc: "0", quantity: "1" }), /^billed_usdc/);
  assert.match(bad({ unit: "$/MB", billed_usdc: "1", quantity: "abc" }), /^quantity/);
  assert.match(bad({ unit: "$/MB", billed_usdc: "1", quantity: "1", vendor: "0x12" }), /^vendor/);
  assert.match(bad({}), /^unit/, "an empty query is refused on the first field");
});

test("a page's searchParams object reads like URLSearchParams, first value wins", () => {
  const r = parseParQuery(
    fromRecord({ unit: ["$/GPU-sec", "$/MB"], billed_usdc: "3", quantity: ["2"], vendor: undefined }),
  );
  assert.ok(r.ok);
  assert.equal(r.q.unit, "$/GPU-sec");
  assert.equal(r.q.quantity, 2);
});

test("the press path percent-encodes the unit, and carries the vendor only when given", () => {
  const q = { unit: "$/1k tokens" as const, billed: 0.02, quantity: 10, vendor: "" };
  assert.equal(parPath(q), "/par?unit=%24%2F1k%20tokens&billed_usdc=0.02&quantity=10");
  const v = "0x" + "a".repeat(40);
  assert.match(parPath({ ...q, vendor: v }), new RegExp(`&vendor=${v}$`));
});

test("the shared query string round-trips through the parser unchanged", () => {
  const q = { unit: "$/MB" as const, billed: 1.5, quantity: 300, vendor: "0x" + "B".repeat(40) };
  const back = parseParQuery((k) => new URLSearchParams(parSearch(q)).get(k));
  assert.ok(back.ok);
  assert.deepEqual(back.q, q);
});
