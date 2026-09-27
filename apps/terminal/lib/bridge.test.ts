import test from "node:test";
import assert from "node:assert/strict";
import { bridgePlan, describeStep, readableWalletError, MAINNET_SOURCES, TESTNET_SOURCES } from "./bridge";
import { chainFacts } from "./chain";

test("bridgePlan: mainnet offers the mainnet sources into `Arc`, testnet the Sepolias into `Arc_Testnet`, anvil nothing", () => {
  const main = bridgePlan(chainFacts({ ...chainFacts(null), chain_id: 5042 } as never));
  assert.equal(main?.arc, "Arc");
  assert.deepEqual(main?.sources, MAINNET_SOURCES);
  const test_ = bridgePlan(chainFacts(null));
  assert.equal(test_?.arc, "Arc_Testnet");
  assert.deepEqual(test_?.sources, TESTNET_SOURCES);
  assert.equal(bridgePlan(chainFacts({ ...chainFacts(null), chain_id: 31337 } as never)), null);
});

test("sources are Base first (where USDC usually is) and never contain Arc itself", () => {
  assert.equal(MAINNET_SOURCES[0].key, "Base");
  for (const s of [...MAINNET_SOURCES, ...TESTNET_SOURCES]) assert.ok(!/^Arc/.test(s.key), s.key);
});

test("describeStep: the kit's step names in the visitor's words, with state", () => {
  assert.equal(describeStep({ name: "approve", state: "pending" }), "approving USDC on the source chain…");
  assert.equal(describeStep({ name: "burn", state: "success" }), "burning on the source chain · done");
  assert.equal(describeStep({ name: "fetchAttestation", state: "pending" }), "waiting for Circle's attestation…");
  assert.equal(describeStep({ name: "mint", state: "error", errorMessage: "reverted" }), "minting on Arc: reverted");
  assert.equal(describeStep({ name: "approve", state: "noop" }), "approving USDC on the source chain · not needed");
  assert.equal(describeStep({ name: "custom", state: "pending" }), "custom…");
});

test("readableWalletError: the errors a visitor meets get a sentence; the rest keep their message", () => {
  assert.equal(readableWalletError({ code: 4001, message: "User rejected the request." }), "you declined in your wallet; nothing was sent");
  assert.equal(readableWalletError({ message: "MetaMask Tx Signature: User denied transaction signature." }), "you declined in your wallet; nothing was sent");
  assert.match(readableWalletError({ code: -32002 }), /already has a request open/);
  assert.match(readableWalletError({ code: 4902 }), /does not know this chain/);
  assert.match(readableWalletError({ message: "insufficient funds for gas * price + value" }), /gas on Arc is USDC/);
  assert.equal(readableWalletError({ shortMessage: "Execution reverted" }), "Execution reverted");
  assert.equal(readableWalletError({}), "the wallet returned no reason");
  assert.ok(readableWalletError({ message: "x".repeat(200) }).endsWith("…"), "long reasons are cut, not dropped");
});
