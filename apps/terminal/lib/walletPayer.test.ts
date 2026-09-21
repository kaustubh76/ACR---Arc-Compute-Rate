import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAIN, chainFacts } from "./chain";
import { addChainParams, decodePaymentRequired, paymentHeader, pickBatchingOption, usdcUnits } from "./walletPayer";

const batching = {
  scheme: "exact",
  network: "eip155:5042002",
  amount: "100",
  extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: CHAIN.gatewayWallet },
};

test("pickBatchingOption: the SDK's own selection rule, on this network only", () => {
  const plain = { scheme: "exact", network: "eip155:5042002", amount: "100" };
  const other = { ...batching, network: "eip155:5042" };
  assert.equal(pickBatchingOption([plain, other, batching], "eip155:5042002"), batching);
  assert.equal(pickBatchingOption([plain], "eip155:5042002"), null, "plain exact is not payable from a Gateway balance");
  assert.equal(pickBatchingOption([batching], "eip155:5042"), null, "wrong chain");
  assert.equal(pickBatchingOption([{ ...batching, extra: { name: "GatewayWalletBatched" } }], "eip155:5042002"), null, "no verifying contract");
  assert.equal(pickBatchingOption(undefined, "eip155:5042002"), null);
});

test("paymentHeader is byte-for-byte the SDK's envelope: base64({...payload, resource, accepted})", () => {
  const payload = { x402Version: 2, payload: { signature: "0xabc", authorization: { value: "100" } } };
  const h = paymentHeader(payload, { url: "https://x/prints" }, batching);
  const decoded = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  assert.deepEqual(decoded, { ...payload, resource: { url: "https://x/prints" }, accepted: batching });
});

test("decodePaymentRequired round-trips, and is null on garbage", () => {
  const body = { x402Version: 2, accepts: [batching], resource: "r" };
  const header = Buffer.from(JSON.stringify(body)).toString("base64");
  assert.deepEqual(decodePaymentRequired(header), body);
  assert.equal(decodePaymentRequired("not base64 json"), null);
  assert.equal(decodePaymentRequired(null), null);
});

test("addChainParams: hex chain id, USDC as the 18-decimal native asset, from the facts", () => {
  const p = addChainParams(chainFacts(null));
  assert.equal(p.chainId, "0x4cef52");
  assert.equal(p.chainName, "Arc Testnet");
  assert.deepEqual(p.nativeCurrency, { name: "USDC", symbol: "USDC", decimals: 18 });
  assert.deepEqual(p.rpcUrls, ["https://rpc.testnet.arc.io"], "the public endpoint, not the bundle's server RPC");
  const m = addChainParams(chainFacts({ ...chainFacts(null), chain_id: 5042, name: "Arc", rpc_url: "https://arc.g.alchemy.com/v2/SECRET", explorer_base: "" } as never));
  assert.equal(m.chainId, "0x13b2");
  assert.deepEqual(m.rpcUrls, ["https://rpc.mainnet.arc.io"], "a keyed server RPC never reaches a wallet");
  const q = addChainParams(chainFacts({ ...chainFacts(null), chain_id: 5042, public_rpc_url: "https://rpc.mainnet.arc.io/x" } as never));
  assert.deepEqual(q.rpcUrls, ["https://rpc.mainnet.arc.io/x"], "the payload's public_rpc_url wins");
});

test("usdcUnits is the 6-decimal ERC-20 view, never the native 18", () => {
  assert.equal(usdcUnits("0.0001"), 100n);
  assert.equal(usdcUnits(1), 1_000_000n);
});
