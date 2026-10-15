/* "Check your card" (lib/cardCheck.ts): every answer the gate can give, read. */
import assert from "node:assert/strict";
import test from "node:test";

import { mintCard, normaliseCard, throwawayKey, MAX_CARD } from "./agentcard";
import { readCardCheck, refusalHint } from "./cardCheck";

const NOW = 1_800_000_000;

test("an accepted card reads its tier, role, audience and time left", () => {
  const body = JSON.stringify({
    tier: "carded",
    carded: true,
    agent: "0xABCD…1234",
    role: "reader",
    audience: "acr-index-api",
    expires_at: NOW + 240,
    ident_kind: "agent-key",
    human_note: "",
  });
  assert.deepEqual(readCardCheck(200, { status: 200, body }, NOW), {
    kind: "accepted",
    tier: "carded",
    role: "reader",
    audience: "acr-index-api",
    agent: "0xABCD…1234",
    expiresInS: 240,
    identKind: "agent-key",
    humanNote: null,
  });
});

test("a refusal carries the press's reason, and the fix for the common one", () => {
  const body = JSON.stringify({ detail: "agent card signature does not match its agent" });
  const v = readCardCheck(200, { status: 401, body }, NOW, 5042);
  assert.equal(v.kind, "refused");
  if (v.kind !== "refused") return;
  assert.equal(v.reason, "agent card signature does not match its agent");
  assert.match(v.hint ?? "", /chain_id 5042/);
  assert.match(refusalHint("agent card has expired", null) ?? "", /900 seconds/);
  assert.match(refusalHint("agent card is addressed to 'x', not 'y'", null) ?? "", /audience/);
});

test("a value that is not a card is refused before it leaves the page's server", () => {
  const v = readCardCheck(400, { detail: "not an agent card: paste the AGENT-CARD header value" }, NOW);
  assert.equal(v.kind, "refused");
  assert.equal(readCardCheck(200, { status: 200, body: JSON.stringify({ carded: false, tier: "anonymous" }) }, NOW).kind, "anonymous");
  assert.equal(readCardCheck(503, { detail: "the press did not answer in time" }, NOW).kind, "unreachable");
});

test("the one rule for what counts as a card", async () => {
  const minted = await mintCard({ privateKey: await throwawayKey(), chainId: 5042, audience: "acr-index-api", name: "t", role: "reader" });
  assert.equal(normaliseCard(`${minted.header}\n`), minted.header, "a pasted newline is trimmed, not refused");
  assert.equal(normaliseCard(`0x${"ab".repeat(32)}`), null, "a private key is never a card");
  assert.equal(normaliseCard(`eyJ${"A".repeat(MAX_CARD)}`), null, "too long");
  assert.equal(normaliseCard("curl -H 'AGENT-CARD: eyJ…'"), null);
});
