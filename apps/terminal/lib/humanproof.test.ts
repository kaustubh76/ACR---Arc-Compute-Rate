/* The terminal's human-proof signer, pinned to what the Python gate recovers. */

import assert from "node:assert/strict";
import test from "node:test";
import { humanProofMessage, signHumanChallenge } from "./humanproof";

const KEY = `0x${"42".repeat(32)}` as const;

test("the payload carries what AgentKitVerifier reads, and the signature recovers to the wallet", async () => {
  const { recoverMessageAddress } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { header, address, payload } = await signHumanChallenge({
    privateKey: KEY, nonce: "n0nce", resource: "/tca/human", host: "acr.test",
  });
  assert.equal(address, privateKeyToAccount(KEY).address);
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert.deepEqual(Object.keys(decoded).sort(), ["address", "chainId", "issuedAt", "nonce", "signature", "signedMessage", "type", "uri"]);
  assert.equal(decoded.nonce, "n0nce");
  assert.equal(decoded.uri, "/tca/human");
  assert.equal(decoded.type, "eip191");
  assert.match(payload.signedMessage, /Nonce: n0nce/);
  assert.match(payload.signedMessage, /URI: \/tca\/human/);
  const who = await recoverMessageAddress({ message: payload.signedMessage, signature: payload.signature });
  assert.equal(who, address);
});

test("the message is the SIWE shape the Python side signs, byte for byte", () => {
  const msg = humanProofMessage("acr.test", "0xAbC", "/tca/human", "n", "2026-09-13T00:00:00.000Z");
  assert.equal(
    msg,
    "acr.test wants you to sign in with your account:\n0xAbC\n\nURI: /tca/human\nVersion: 1\nChain ID: 480\nNonce: n\nIssued At: 2026-09-13T00:00:00.000Z",
  );
});
