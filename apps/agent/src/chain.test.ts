import assert from "node:assert/strict";
import { test } from "node:test";
import { agentChain } from "./chain.js";

test("default is testnet, unchanged from what the agent has paid on", () => {
  const c = agentChain({});
  assert.equal(c.chainId, 5042002);
  assert.equal(c.gatewayChain, "arcTestnet");
  assert.equal(c.ubkChain, "Arc_Testnet");
  assert.equal(c.privateMainnet, false);
});

test("mainnet resolves the SDK chain key and the preview flag", () => {
  const c = agentChain({ ACR_ARC_CHAIN_ID: "5042" });
  assert.equal(c.gatewayChain, "arc");
  assert.equal(c.caip2, "eip155:5042");
  assert.equal(c.privateMainnet, true);
  assert.equal(agentChain({ ACR_ARC_CHAIN_ID: "5042", ACR_ARC_PRIVATE_MAINNET: "0" }).privateMainnet, false);
  assert.equal(agentChain({ ACR_ARC_CHAIN_ID: "5042" }).ubkChain, null, "the kit cannot deposit on mainnet yet");
  assert.equal(agentChain({ ACR_ARC_CHAIN_ID: "5042", AGENT_UBK_CHAIN: "Arc" }).ubkChain, "Arc", "until a kit that knows it ships");
});

test("an unknown chain id is refused, not paid on", () => {
  assert.throws(() => agentChain({ ACR_ARC_CHAIN_ID: "1" }), /not an Arc network/);
});
