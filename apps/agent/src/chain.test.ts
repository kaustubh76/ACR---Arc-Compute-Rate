import assert from "node:assert/strict";
import { test } from "node:test";
import { agentChain } from "./chain.js";

test("default is MAINNET — the chain the README's own command talks to", () => {
  // Was 5042002, and nothing set ACR_ARC_CHAIN_ID, so following the README
  // verbatim paid on testnet against the mainnet seller. The old test's name
  // carried the reason it was once right: "unchanged from what the agent has
  // paid on". That stopped being true on 2026-09-27.
  const c = agentChain({});
  assert.equal(c.chainId, 5042);
  assert.equal(c.caip2, "eip155:5042");
  assert.equal(c.gatewayChain, "arc");
  assert.equal(c.ubkChain, "Arc", "kit 1.7.0 names mainnet");
  assert.equal(c.privateMainnet, false, "the preview ended");
});

test("testnet is still reachable by asking for it — the table keeps both", () => {
  // Moving the default must not delete the network this was proven on.
  const c = agentChain({ ACR_ARC_CHAIN_ID: "5042002" });
  assert.equal(c.chainId, 5042002);
  assert.equal(c.caip2, "eip155:5042002");
  assert.equal(c.gatewayChain, "arcTestnet");
  assert.equal(c.ubkChain, "Arc_Testnet");
});

test("mainnet resolves the SDK chain key and the preview flag", () => {
  const c = agentChain({ ACR_ARC_CHAIN_ID: "5042" });
  assert.equal(c.gatewayChain, "arc");
  assert.equal(c.caip2, "eip155:5042");
  assert.equal(c.privateMainnet, false);
  assert.equal(agentChain({ ACR_ARC_CHAIN_ID: "5042", ACR_ARC_PRIVATE_MAINNET: "1" }).privateMainnet, true);
  assert.equal(agentChain({ ACR_ARC_CHAIN_ID: "5042" }).ubkChain, "Arc", "kit 1.7.0 names mainnet");
  assert.equal(agentChain({ ACR_ARC_CHAIN_ID: "5042", AGENT_UBK_CHAIN: "Arc_X" }).ubkChain, "Arc_X", "the env still overrides");
  assert.equal(agentChain({ ACR_ARC_CHAIN_ID: "5042" }).privateMainnet, false, "the preview ended");
});

test("an unknown chain id is refused, not paid on", () => {
  assert.throws(() => agentChain({ ACR_ARC_CHAIN_ID: "1" }), /not an Arc network/);
});
