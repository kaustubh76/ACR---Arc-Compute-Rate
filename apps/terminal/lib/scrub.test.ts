import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubCaption, scrubIndex, stepScrub } from "./scrub";

test("a pointer resolves to the nearest point and is clamped to the element", () => {
  assert.equal(scrubIndex(0, 240, 24), 0);
  assert.equal(scrubIndex(240, 240, 24), 23);
  assert.equal(scrubIndex(120, 240, 24), 12);
  assert.equal(scrubIndex(-50, 240, 24), 0, "left of the element is the oldest point");
  assert.equal(scrubIndex(900, 240, 24), 23, "right of the element is the newest point");
});

test("nothing to scrub is null, not an index", () => {
  assert.equal(scrubIndex(10, 240, 1), null, "one point has no neighbours");
  assert.equal(scrubIndex(10, 240, 0), null);
  assert.equal(scrubIndex(10, 0, 24), null, "an unlaid-out element has no width");
});

test("the keys step, jump and clear, and anything else passes through", () => {
  assert.equal(stepScrub(null, "ArrowLeft", 24), 23, "left from nothing starts at the newest");
  assert.equal(stepScrub(null, "ArrowRight", 24), 0, "right from nothing starts at the oldest");
  assert.equal(stepScrub(5, "ArrowLeft", 24), 4);
  assert.equal(stepScrub(0, "ArrowLeft", 24), 0, "no wrap at the oldest");
  assert.equal(stepScrub(23, "ArrowRight", 24), 23, "no wrap at the newest");
  assert.equal(stepScrub(9, "Home", 24), 0);
  assert.equal(stepScrub(9, "End", 24), 23);
  assert.equal(stepScrub(9, "Escape", 24), null);
  assert.equal(stepScrub(9, "Tab", 24), undefined, "tab must keep moving focus");
  assert.equal(stepScrub(null, "ArrowLeft", 1), undefined, "one point: the keys do nothing");
});

test("the caption names the fixing and counts back from the newest", () => {
  const points = [34, 35, 36].map((n) => ({ ts: n * 3600 }));
  assert.deepEqual(scrubCaption(points, 0), { label: "Nº 34", ago: 2 });
  assert.deepEqual(scrubCaption(points, 2), { label: "Nº 36", ago: 0 });
});
