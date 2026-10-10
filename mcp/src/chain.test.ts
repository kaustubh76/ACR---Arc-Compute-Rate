import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { arcChain, knownChainIds, USDC_ADDRESS, USDC_DECIMALS } from "./chain.js";

/* The file `chain.ts` has been promising since it was written.
 *
 * Its header says the three-copy duplication "is pinned by a test instead
 * (`chain.test.ts`)". That file did not exist. The copies happened to agree —
 * I diffed all three by hand on 2026-10-10 and found no drift — so this is a
 * promise being kept, not a bug being fixed. It is worth keeping because the
 * testnet row is what a testnet settlement's CUSTODY depends on: `gatewayWallet`
 * is where the payer's x402 float is held, and a wrong one would build an
 * authorization against a contract holding nothing, which surfaces as an opaque
 * SDK failure rather than as "wrong address".
 *
 * `acr_core/config.py` is the canonical table (`CHAIN_PROFILES`). It is parsed
 * rather than imported, because this package has no Python and must not gain a
 * dependency on the monorepo to run its own tests.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PY = join(
  __dirname, "..", "..", "packages", "acr_core", "acr_core", "config.py",
);

/** The fields of one `ChainProfile(...)` call, by chain id. */
function pythonProfiles(src: string): Record<number, Record<string, string>> {
  const out: Record<number, Record<string, string>> = {};
  // Each entry looks like `    5042: ChainProfile(` … `    ),`
  const re = /(\d+):\s*ChainProfile\(([\s\S]*?)\n\s*\),/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const fields: Record<string, string> = {};
    const body = m[2];
    const fre = /(\w+)\s*=\s*(?:"([^"]*)"|(True|False))/g;
    for (let f = fre.exec(body); f; f = fre.exec(body)) {
      fields[f[1]] = f[2] !== undefined ? f[2] : f[3];
    }
    out[Number(m[1])] = fields;
  }
  return out;
}

test("the press's own chain table is the one this package carries", () => {
  const py = pythonProfiles(readFileSync(CONFIG_PY, "utf8"));
  assert.ok(py[5042] && py[5042002], "config.py should still declare both Arcs");

  for (const id of [5042, 5042002]) {
    const ours = arcChain(id, {} as NodeJS.ProcessEnv);
    assert.ok(ours, `no profile for ${id}`);
    const theirs = py[id];
    assert.equal(ours.name, theirs.name, `${id}: name`);
    assert.equal(ours.explorer, theirs.explorer, `${id}: explorer`);
    assert.equal(ours.publicRpc, theirs.public_rpc, `${id}: public_rpc`);
    // THE ONE THAT MOVES MONEY.
    assert.equal(ours.gatewayWallet, theirs.gateway_wallet, `${id}: gateway_wallet`);
    assert.equal(ours.gatewayChain, theirs.gateway_chain, `${id}: gateway_chain`);
    assert.equal(ours.privateMainnet, theirs.private_mainnet === "True", `${id}: private_mainnet`);
  }
});

test("the terminal's copy agrees as well, per chain and not merely somewhere", () => {
  /* Four copies of this table exist. Pinning each to Python independently would
     let the TypeScript ones drift from each other while both matched it, so
     they are checked against each other too — the same argument as
     printAge.test.ts.
     THE FIRST VERSION OF THIS ASSERTION WAS USELESS, and a mutation run is how
     I know: it asked only whether the terminal's file CONTAINED our Gateway
     wallet string. Swapping the testnet row's custody address for mainnet's —
     the exact copy-paste this file exists to catch — left it green, because the
     terminal contains both addresses. A containment check across a file that
     holds every chain's values can never distinguish them. So the block is
     matched by its own `chainId` and the wallet read from inside it. */
  const TERM = join(__dirname, "..", "..", "apps", "terminal", "lib", "chain.ts");
  const src = readFileSync(TERM, "utf8");
  for (const id of [5042, 5042002]) {
    const ours = arcChain(id, {} as NodeJS.ProcessEnv);
    assert.ok(ours);
    // The block declaring this chainId, up to its closing brace.
    const block = new RegExp(`chainId:\\s*${id},([\\s\\S]*?)\\n\\} as const;`).exec(src);
    assert.ok(block, `the terminal's chain.ts no longer declares chainId ${id}`);
    const wallet = /gatewayWallet:\s*"([^"]+)"/.exec(block[1]);
    const gwChain = /gatewayChain:\s*"([^"]+)"/.exec(block[1]);
    assert.ok(wallet && gwChain, `${id}: the terminal's block lost gatewayWallet/gatewayChain`);
    assert.equal(wallet[1], ours.gatewayWallet, `${id}: the terminal's Gateway wallet`);
    assert.equal(gwChain[1], ours.gatewayChain, `${id}: the terminal's Gateway chain key`);
  }
});

test("the two Gateway wallets are different, which is the whole hazard", () => {
  /* Stated as its own assertion because the failure it guards is a copy-paste:
     one chain's custody address used for the other. USDC is the same predeploy
     on both Arcs, so the ADDRESS of the money is not what distinguishes them —
     the custody contract is. */
  const main = arcChain(5042, {} as NodeJS.ProcessEnv);
  const test_ = arcChain(5042002, {} as NodeJS.ProcessEnv);
  assert.notEqual(main?.gatewayWallet, test_?.gatewayWallet);
  assert.notEqual(main?.gatewayChain, test_?.gatewayChain);
  assert.notEqual(main?.publicRpc, test_?.publicRpc);
});

test("USDC is the same predeploy on both, at six decimals", () => {
  /* The 18-decimal native view is the same money in different units, and
     reading it as six is a balance wrong by a factor of 10^12. Pinned against
     the press's own constant rather than restated. */
  const src = readFileSync(CONFIG_PY, "utf8");
  assert.ok(
    src.includes(USDC_ADDRESS),
    `config.py no longer names ${USDC_ADDRESS} — Arc's USDC predeploy moved, or this is stale`,
  );
  assert.equal(USDC_DECIMALS, 6);
});

test("an id with no row is null, never the first profile", () => {
  /* `arcChain` returning a profile for an unknown chain is how an agent builds
     a payment for the wrong network. 31337 is in the Python table as an anvil
     placeholder with empty fields; this package deliberately has no row for it,
     because an empty Gateway wallet is not a payable chain. */
  for (const id of [1, 8453, 31337, 5042003, 0, -1]) {
    assert.equal(arcChain(id, {} as NodeJS.ProcessEnv), null, `${id} should have no profile`);
  }
  assert.deepEqual(knownChainIds().sort((a, b) => a - b), [5042, 5042002]);
});

test("ACR_ARC_RPC_URL overrides the RPC and nothing else", () => {
  /* It is a single global override applied to whichever profile is asked for,
     with no `eth_chainId` confirmation — so a testnet RPC used with the mainnet
     profile would read confident, wrong balances. Not fixed here (a probe on
     every resolve is a request per tool call); pinned so the blast radius stays
     exactly one field. */
  const env = { ACR_ARC_RPC_URL: "https://rpc.example.invalid" } as unknown as NodeJS.ProcessEnv;
  for (const id of [5042, 5042002]) {
    const base = arcChain(id, {} as NodeJS.ProcessEnv);
    const over = arcChain(id, env);
    assert.ok(base && over);
    assert.equal(over.publicRpc, "https://rpc.example.invalid");
    assert.equal(over.gatewayWallet, base.gatewayWallet, "an RPC override must not move custody");
    assert.equal(over.gatewayChain, base.gatewayChain);
    assert.equal(over.chainId, base.chainId);
  }
});
