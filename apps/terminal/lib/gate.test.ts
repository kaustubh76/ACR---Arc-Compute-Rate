/* The four states a screen can be in, and why two of them are not one.
 *
 * This mirrors humans.test.ts's central rule — an unread tape is null, never 0 —
 * applied to the other gate: an unread screen is "unread", never "off". The two
 * render differently because they mean different things, and a footer that
 * collapsed them would report a deliberate configuration where it should be
 * reporting its own blindness.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ArmorInfo } from "./gate";
import { screenState, screenedCount } from "./gate";

function info(over: Partial<ArmorInfo> = {}): ArmorInfo {
  return { backend: "gcp", screened: 0, blocked: 0, mode: "auto", live: true, ...over };
}

test("an unread screen is unread, not off", () => {
  assert.equal(screenState(null), "unread");
  assert.equal(screenState(undefined), "unread");
});

test("a real Model Armor backend is live", () => {
  assert.equal(screenState(info({ backend: "gcp", live: true })), "live");
});

test("the offline floor is a floor, not a screen", () => {
  /* LocalScreen is six substrings. Reporting it as `live` is exactly the
     overclaim /armor/info was built to prevent, so the state is named for what it
     is and the footer says "not Model Armor" out loud. */
  assert.equal(screenState(info({ backend: "local", live: false })), "floor");
});

test("a gcp backend that is not configured is still only a floor", () => {
  /* The trap: `backend` says what the object IS, `live` says whether it can reach
     anything. A screen forced to gcp with no credentials would answer "gcp" while
     inspecting nothing, which is the precise failure this pair of fields exists to
     separate. Both have to agree before anything claims to be screening. */
  assert.equal(screenState(info({ backend: "gcp", live: false })), "floor");
});

test("switched off is a configuration and says so", () => {
  assert.equal(screenState(info({ backend: "off", live: false })), "off");
});

test("an unread count is null, never zero", () => {
  /* Sharper here than anywhere else: until the screen had a call site at all, this
     counter was STRUCTURALLY stuck at zero. A confident 0 is the one reading that
     was indistinguishable from the bug. */
  assert.equal(screenedCount(null), null);
  assert.equal(screenedCount(info({ screened: 0 })), 0);
  assert.equal(screenedCount(info({ screened: 41 })), 41);
});

test("a non-numeric count is absence, not a coerced zero", () => {
  assert.equal(screenedCount({ ...info(), screened: undefined as unknown as number }), null);
});
