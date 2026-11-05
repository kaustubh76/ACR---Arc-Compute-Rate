/**
 * Stand up the whole Float system on a local anvil and prove it runs.
 *
 *   cd contracts && forge build          # artifacts must exist
 *   anvil                                # port 8545
 *   cd float && npm run local
 *
 * Uses the SAME role addresses as the testnet deploy — read from the gitignored
 * key files — and funds them from anvil's prefunded account, rather than using
 * anvil's own accounts. That fidelity is the point: the local run exercises the
 * same addresses, the same role separation and the same encoding, so the only
 * difference left on testnet is gas and latency.
 *
 * Deploys test doubles for USDC and the yield venue because a local chain has
 * neither. Nothing here is ever deployed to Arc: `DeployFloat.s.sol` points the
 * sleeve at the real Morpho vault.
 */
import { keccak256, parseEther, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  anvil,
  addressFor,
  feeFor,
  keyFor,
  publicFor,
  walletFor,
} from "../chain.ts";
import * as A from "../artifacts.ts";
import { save, type Deployment } from "../deployments.ts";

const NET = "anvil" as const;
const pub = publicFor(NET);

/** anvil's first prefunded account — only ever used to fund the real roles. */
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const GUEST_CAP = 2_000_000n; // 2 USDC, matching the testnet deploy
const SCOUT = keccak256(toHex("scout"));
const WASTER = keccak256(toHex("waster"));

const POLICY = {
  maxPremiumBps: 100,
  humanMaxPremiumBps: 2000,
  maxPrintAge: 1800,
  upperBandBps: 1500,
  lowerBandBps: 1000,
  workingShareBps: 10000,
  bufferHours: 48,
  minTicketUsdc: 1_000_000n,
} as const;

async function main() {
  const chainId = await pub.getChainId().catch(() => {
    throw new Error("no chain at 127.0.0.1:8545 — start `anvil` first");
  });
  if (chainId !== anvil.id) {
    // A foreign chain on this port is a real hazard: a suite once ran happily
    // against another session's node and reported green against the wrong state.
    throw new Error(`chain id ${chainId} on 8545 is not anvil (${anvil.id}) — whose node is this?`);
  }

  const funder = (await import("viem")).createWalletClient({
    account: privateKeyToAccount(ANVIL_0),
    chain: anvil,
    transport: (await import("viem")).http("http://127.0.0.1:8545"),
  });

  const deployer = walletFor(NET, "deployer");
  const executor = walletFor(NET, "executor");
  const keeper = walletFor(NET, "keeper");
  // The approver must not be an executor; the vault enforces it. On anvil the
  // deployer doubles as the approver, which is exactly the flag-off shape.
  const approver = deployer;

  for (const w of [deployer, executor, keeper]) {
    const hash = await funder.sendTransaction({
      to: w.account!.address,
      value: parseEther("10"),
      chain: anvil,
    });
    await pub.waitForTransactionReceipt({ hash });
  }
  console.log(`funded deployer/executor/keeper from anvil account 0`);

  const dep = async (art: A.Artifact, args: unknown[]): Promise<Address> => {
    const hash = await deployer.deployContract({
      abi: art.abi,
      bytecode: art.bytecode,
      args: args as never,
      account: deployer.account!,
      chain: anvil,
      ...feeFor(NET),
    });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error("deploy produced no address");
    return r.contractAddress;
  };

  const usdc = await dep(A.MockUSDC(), []);
  const venue = await dep(A.MockVault4626(), [usdc]);
  const printStore = await dep(A.FloatPrintStore(), []);
  const vault = await dep(A.FloatVault(), [usdc, printStore, GUEST_CAP]);
  const sleeve = await dep(A.Erc4626Sleeve(), [venue, usdc, vault]);
  const seller = await dep(A.FloatTestSeller(), [usdc]);

  const write = async (
    to: Address,
    art: A.Artifact,
    fn: string,
    args: unknown[],
    who = deployer,
  ) => {
    const hash = await who.writeContract({
      address: to,
      abi: art.abi,
      functionName: fn,
      args: args as never,
      account: who.account!,
      chain: anvil,
      ...feeFor(NET),
    });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${fn} reverted`);
    return hash;
  };

  const V = A.FloatVault();
  const S = A.FloatPrintStore();
  const U = A.MockUSDC();

  await write(printStore, S, "setSigner", [keeper.account!.address, true]);
  await write(vault, V, "wire", [
    executor.account!.address,
    keeper.account!.address,
    approver.account!.address,
    deployer.account!.address, // guest registrar
    deployer.account!.address, // studio deployer
    sleeve,
    "0x0000000000000000000000000000000000000000",
  ]);

  const NO_SIG = [0, `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`];
  await write(vault, V, "setPolicy", [POLICY, keccak256(toHex("float.policy.seed.v1")), 0n, ...NO_SIG]);
  for (const [id, name] of [
    [SCOUT, "scout"],
    [WASTER, "waster"],
  ] as const) {
    await write(vault, V, "setAgent", [
      id,
      25_000_000n,
      5_000_000n,
      false,
      keccak256(toHex(`float.agent.${name}.v1`)),
      0n,
      ...NO_SIG,
    ]);
    await write(vault, V, "allowSeller", [id, seller, true, 0n, ...NO_SIG]);
  }
  await write(vault, V, "allowGuestSeller", [seller, true]);

  // Fund the treasury, and park most of it in the sleeve so the very first
  // payment has to pull just-in-time — the behaviour worth watching.
  await write(usdc, U, "mint", [vault, 100_000_000n]);
  console.log("minted 100 USDC to the vault");

  const d: Deployment = {
    net: NET,
    chainId,
    usdc,
    venue,
    printStore,
    vault,
    sleeve,
    seller,
    deployer: deployer.account!.address,
    executor: executor.account!.address,
    keeper: keeper.account!.address,
    approver: approver.account!.address,
    deployedAt: new Date().toISOString(),
  };
  const where = save(d);

  console.log("");
  for (const [k, v] of Object.entries(d)) console.log(`  ${k.padEnd(12)} ${v}`);
  console.log(`\nwrote ${where}`);
  console.log("Next: `npm run keeper -- --once` to print, then `npm run agents -- --once`.");
  console.log("Every spend is refused 'no print for index' until the keeper has run.");
}

await main();
