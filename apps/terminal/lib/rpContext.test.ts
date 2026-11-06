/* The SDK-to-wire rename in app/api/float/idkit/context/route.ts, which two
 * comments claimed was "pinned by a test" while no such test existed.
 *
 * It matters because of the failure SHAPE. `signRequest` returns
 * `{sig, createdAt, expiresAt}`; the widget's `rp_context` wants
 * `{signature, created_at, expires_at}`. Hand the widget the signer's own
 * shape and it renders perfectly, opens a real sheet on a real phone, and
 * only then fails at World. Nothing local goes red. So the guard has to be
 * here, and it has to pin BOTH ends: the names the SDK emits, and the names
 * the route emits. Either one drifting is the bug.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TERMINAL = join(dirname(fileURLToPath(import.meta.url)), "..");
const route = (p: string) => readFileSync(join(TERMINAL, p), "utf8");
const CONTEXT_ROUTE = "app/api/float/idkit/context/route.ts";

test("rpContextTest: the SDK still emits the camelCase names the route renames", async () => {
  const { signRequest } = await import("@worldcoin/idkit/signing");
  /* A throwaway key, because signRequest is pure local secp256k1: no
     registration, no network, and the nonce is generated here rather than
     issued. That is what makes this assertion possible with no credential. */
  const signed = signRequest({
    signingKeyHex: randomBytes(32).toString("hex"),
    action: "acr-float-guest-budget-v1",
    ttl: 240,
  });
  assert.deepEqual(Object.keys(signed).sort(), ["createdAt", "expiresAt", "nonce", "sig"]);
  assert.match(signed.sig, /^0x[0-9a-f]+$/i);
  assert.match(signed.nonce, /^0x[0-9a-f]{64}$/i);
  assert.ok(signed.expiresAt > signed.createdAt, "a ttl that does not move is not a ttl");
});

test("rpContextTest: the route maps all three renamed fields, and leaks none", () => {
  const src = route(CONTEXT_ROUTE);
  /* Anchor FORWARD from the literal. `return NextResponse.json` also appears
     in the refusal paths above it, so indexOf would slice backwards to an
     empty string and every assertion below would vacuously pass. */
  const start = src.indexOf("rp_context: {");
  assert.ok(start > 0, "the rp_context literal moved");
  const block = src.slice(start, src.indexOf("};", start));
  assert.ok(block.length > 40, "the rp_context block did not close as expected");

  for (const [wire, sdk] of [
    ["created_at", "signed.createdAt"],
    ["expires_at", "signed.expiresAt"],
    ["signature", "signed.sig"],
  ]) {
    assert.ok(block.includes(`${wire}: ${sdk}`), `rp_context must carry ${wire}: ${sdk}`);
  }
  assert.ok(block.includes("nonce: signed.nonce"), "nonce passes through unrenamed");

  /* The leak direction. A spread of the signer's result, or a shorthand
     `sig,`, would put camelCase on the wire while every local check passed. */
  for (const leaked of ["sig:", "createdAt:", "expiresAt:", "...signed"]) {
    assert.ok(!block.includes(leaked), `${leaked} must not reach rp_context`);
  }
});

test("rpContextTest: the shipped rp_id regex refuses a 64-hex public key id", () => {
  const src = route(CONTEXT_ROUTE);
  /* Exercise the REAL literal rather than a copy of it, so a loosened regex
     in the route fails here instead of passing against a stale duplicate. */
  const m = src.match(/const RP_ID_RE = (\/.+?\/)[;\n]/);
  assert.ok(m, "RP_ID_RE is no longer a literal this test can reach");
  const re = new RegExp(m![1].slice(1, -1));

  /* The rule came from idkit-core's own normalizer, which slices an rp_id to
     a uint64. The 64-hex public key id is a different value of a different
     width, and pasting it here is the mistake this refuses. */
  assert.ok(!re.test("rp_8e6e1f2a1128de6c7c714bcf29d25b0399430c4f5cdd6e053d10047f670027dc"));
  assert.ok(!re.test("rp_00000000000000001"), "17 hex digits overflows a uint64");
  assert.ok(!re.test("app_eb924b44ddfe9598cf9d2098ef047a34"), "an app_id is not an rp_id");
  assert.ok(re.test("rp_0000000000000001"), "16 hex digits is the widest legal rp_id");
  assert.ok(re.test("rp_1"));
});
