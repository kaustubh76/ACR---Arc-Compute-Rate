import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshHeaders,
  keepLast,
  ok,
  readFailure,
  readHeaders,
  readStatus,
  shouldMemo,
  unread,
} from "./readResult";

test("an unread result is never cached — one blip must not become everyone's answer", () => {
  // The measured bug: a throttled position read was served 200 with
  // s-maxage=10, so the CDN handed the same wrong state to every visitor for
  // ten seconds and the retry never reached the origin.
  assert.equal(readHeaders(unread("desk.position"))["Cache-Control"], "no-store");
  assert.match(readHeaders(ok({ contracts: 1 }))["Cache-Control"], /s-maxage=10/);

  /* And the header for a read a reader ASKED for. Same file, opposite answer,
     because a 10s shared cache is a saving on a page's own fetch and a lie on a
     button: measured on production, /api/registry replayed one block number for
     forty seconds under x-vercel-cache: STALE with stale-while-revalidate=30
     doing the damage after s-maxage expired. Assert the absence of both knobs,
     not just the presence of no-store, since it was the SWR tail that bit. */
  const fresh = freshHeaders()["Cache-Control"];
  assert.equal(fresh, "no-store");
  assert.doesNotMatch(fresh, /s-maxage|stale-while-revalidate/);
});

test("an unread result asks again instead of answering", () => {
  assert.equal(readStatus(ok(1)), 200);
  assert.equal(readStatus(unread("x")), 503);
});

test("a failed read keeps the last good value instead of replacing it", () => {
  // Stale-and-true beats fresh-and-invented. This is the fix for a throttled
  // poll telling a reader holding a position that they are flat.
  const good = { contracts: 0.81, avg_price: 0.49, upnl_usdc: 0.01, realized_usdc: 0 };
  assert.deepEqual(keepLast(good, unread("desk.position")), good);
  // A genuine zero still lands — "we read it and you are flat" is a real answer
  // and must be distinguishable from "we could not read it".
  const flat = { ...good, contracts: 0 };
  assert.deepEqual(keepLast(good, ok(flat)), flat);
  // Null is a legitimate value inside ok(): "read, and there is no position".
  assert.equal(keepLast(good, ok(null as unknown as typeof good)), null);
});

test("a failure never enters a memo", () => {
  // The position memo cached its null for 15s, so one blip decided the answer
  // for the whole window however often the desk polled.
  assert.equal(shouldMemo(ok([])), true);
  assert.equal(shouldMemo(unread("desk.fills")), false);
});

test("an empty answer is still an answer", () => {
  // The distinction the whole module exists for: a genuinely empty list is a
  // fact worth caching and rendering; an unreadable one is neither.
  const empty = ok<number[]>([]);
  assert.equal(shouldMemo(empty), true);
  assert.equal(readStatus(empty), 200);
  assert.equal(empty.ok && empty.value.length, 0);
});

test("a swallowed failure leaves a findable line", () => {
  // The production failure left NOTHING in the runtime logs, which read as
  // "nothing went wrong". The format is asserted here because the call site
  // only does console.error(readFailure(...)).
  const line = readFailure("desk.fills", { series: 3, addr: "0xc972" }, new Error("HTTP 429"));
  assert.match(line, /^acr\.read\.fail scope=desk\.fills /);
  assert.match(line, /series=3/);
  assert.match(line, /addr=0xc972/);
  assert.match(line, /err=HTTP 429/);
  // One line, always — a multi-line log entry is one a grep will cut in half.
  assert.ok(!line.includes("\n"));
});

test("the log line survives a hostile error", () => {
  const noisy = new Error("line one\nline two\n\tindented");
  assert.ok(!readFailure("s", {}, noisy).includes("\n"));
  assert.ok(readFailure("s", {}, "x".repeat(500)).length < 260);
  assert.equal(readFailure("s", {}), "acr.read.fail scope=s");
  assert.equal(readFailure("s", {}, null), "acr.read.fail scope=s");
});
