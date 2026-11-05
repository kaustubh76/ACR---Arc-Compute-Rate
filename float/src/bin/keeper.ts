/**
 * The background loop: price the models, forecast the spend, move the float.
 *
 *   FLOAT_NET=anvil npm run keeper -- --once
 *   FLOAT_NET=arc-testnet npm run keeper
 *
 * Three jobs, in order, because each depends on the last:
 *
 *   1. PRINT. Per-provider prices for each seeded model, blended and medianed
 *      the way ACR's own basket does it, written on chain with an incrementing
 *      id. Nothing can be spent until this has run: the vault refuses every
 *      request with "no print for index" until a price exists, which is the
 *      correct resting state for a treasury that prices what it buys.
 *
 *   2. FORECAST. What the fleet is actually spending, from the vault's own
 *      Receipt events, times the hours of cover the policy asks for, times the
 *      provider disagreement. The margin is MEASURED, not assumed — that is
 *      what the confidence interval in a print is for.
 *
 *   3. REBALANCE. Ask the vault to move the difference. It refuses inside its
 *      bands and below its minimum ticket, so calling this every tick is safe
 *      and usually does nothing.
 */
import { formatUnits, keccak256, parseAbiItem, toHex, type Address } from "viem";
import { feeFor, netFromEnv, publicFor, walletFor } from "../chain.ts";
import * as A from "../artifacts.ts";
import { load } from "../deployments.ts";
import { SEED_MODELS } from "../seed.ts";
import { fetchPrint, indexIdFor, wadToUsd } from "../prices.ts";

const NET = netFromEnv();
const ONCE = process.argv.includes("--once");
const TICK_MS = 10 * 60 * 1000;

const pub = publicFor(NET);
const keeper = walletFor(NET, "keeper");
const d = load(NET);

const STORE = A.FloatPrintStore();
const VAULT = A.FloatVault();

const RECEIPT = parseAbiItem(
  "event Receipt(uint256 indexed id, bytes32 indexed agentId, address indexed seller, bytes32 index, uint64 printId, uint256 units, uint256 quote, uint256 fair, int256 premiumBps, bool jitFunded, bool guest, bool humanApproved)",
);

/** Arc caps `eth_getLogs` at a 10,000-block range, so reach comes from paging. */
const LOG_PAGE = 9_000n;

function usdc(n: bigint): string {
  return `$${formatUnits(n, 6)}`;
}

async function send(to: Address, abi: A.Artifact["abi"], fn: string, args: unknown[]) {
  const hash = await keeper.writeContract({
    address: to,
    abi,
    functionName: fn,
    args: args as never,
    account: keeper.account!,
    chain: keeper.chain,
    ...feeFor(NET),
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
  return hash;
}

async function print() {
  for (const model of SEED_MODELS) {
    const name = indexIdFor(model);
    const index = keccak256(toHex(name));
    try {
      const p = await fetchPrint(model);

      // Name the index once, so a receipt on chain says which model it bought
      // rather than naming a hash the reader has to look up elsewhere.
      const known = (await pub.readContract({
        address: d.printStore,
        abi: STORE.abi,
        functionName: "indexName",
        args: [index],
      })) as string;
      if (!known) await send(d.printStore, STORE.abi, "nameIndex", [index, name]);

      await send(d.printStore, STORE.abi, "setPrint", [index, p.priceWad, p.ciBps]);
      const [, id] = (await pub.readContract({
        address: d.printStore,
        abi: STORE.abi,
        functionName: "latest",
        args: [index],
      })) as [bigint, bigint, bigint, number];
      console.log(
        `  print #${id} ${name.padEnd(42)} $${wadToUsd(p.priceWad, 9)}/1k ci=${p.ciBps}bp (${p.providers.length} providers)`,
      );
    } catch (e) {
      // A model the market stopped pricing must not take the loop down with it:
      // the other two still have fresh prices, and a stale print is a refusal
      // the vault already knows how to make.
      console.log(`  print ${name}: SKIPPED — ${(e as Error).message}`);
    }
  }
}

/**
 * Spend per hour, measured from the vault's own receipts.
 *
 * Reads the chain rather than a local file on purpose: the forecast is then
 * derived from the same evidence a judge can audit, and a keeper restart loses
 * nothing. With no receipts yet it returns zero and says so — an invented rate
 * would be a number pretending to be a measurement.
 */
async function spendPerHour(): Promise<{ perHour: bigint; receipts: number; hours: number }> {
  const head = await pub.getBlockNumber();
  const window = NET === "anvil" ? head : LOG_PAGE;
  const from = head > window ? head - window : 0n;

  let total = 0n;
  let count = 0;
  let firstTs = 0;
  let lastTs = 0;
  for (let start = from; start <= head; start += LOG_PAGE) {
    const to = start + LOG_PAGE - 1n > head ? head : start + LOG_PAGE - 1n;
    const logs = await pub.getLogs({ address: d.vault, event: RECEIPT, fromBlock: start, toBlock: to });
    for (const l of logs) {
      total += (l.args as { quote?: bigint }).quote ?? 0n;
      count += 1;
    }
    if (logs.length > 0) {
      const b0 = await pub.getBlock({ blockNumber: logs[0]!.blockNumber! });
      const b1 = await pub.getBlock({ blockNumber: logs[logs.length - 1]!.blockNumber! });
      if (!firstTs) firstTs = Number(b0.timestamp);
      lastTs = Number(b1.timestamp);
    }
  }
  const hours = Math.max((lastTs - firstTs) / 3600, 1 / 60);
  return { perHour: count > 1 ? total / BigInt(Math.max(1, Math.round(hours))) : total, receipts: count, hours };
}

async function rebalance() {
  const policy = (await pub.readContract({
    address: d.vault,
    abi: VAULT.abi,
    functionName: "policy",
  })) as readonly [number, number, number, number, number, number, number, bigint];
  const bufferHours = BigInt(policy[6]);

  const { perHour, receipts } = await spendPerHour();
  if (receipts === 0) {
    console.log("  forecast: no receipts yet, so no measured rate — nothing to rebalance against");
    return;
  }

  // The margin is the provider disagreement, averaged over the printed indices.
  let ciSum = 0n;
  let n = 0n;
  const count = (await pub.readContract({
    address: d.printStore,
    abi: STORE.abi,
    functionName: "indexCount",
  })) as bigint;
  for (let i = 0n; i < count; i += 1n) {
    const index = (await pub.readContract({
      address: d.printStore,
      abi: STORE.abi,
      functionName: "indexAt",
      args: [i],
    })) as `0x${string}`;
    const [, , , ci] = (await pub.readContract({
      address: d.printStore,
      abi: STORE.abi,
      functionName: "latest",
      args: [index],
    })) as [bigint, bigint, bigint, number];
    ciSum += BigInt(ci);
    n += 1n;
  }
  const ciBps = n > 0n ? ciSum / n : 0n;

  const target = (perHour * bufferHours * (10_000n + ciBps)) / 10_000n;
  const held = (await pub.readContract({
    address: d.usdc,
    abi: A.MockUSDC().abi,
    functionName: "balanceOf",
    args: [d.vault],
  })) as bigint;

  console.log(
    `  forecast: ${usdc(perHour)}/h over ${receipts} receipts, ${bufferHours}h cover, +${ciBps}bp margin`,
  );
  console.log(`  target buffer ${usdc(target)} vs held ${usdc(held)}`);
  const hash = await send(d.vault, VAULT.abi, "rebalance", [target]);
  console.log(`  rebalance ${hash}`);
}

async function tick() {
  console.log(`[keeper ${new Date().toISOString()}] ${NET}`);
  await print();
  await rebalance();
}

await tick();
if (!ONCE) {
  console.log(`\nticking every ${TICK_MS / 60000} minutes. Ctrl-C to stop.`);
  setInterval(() => {
    tick().catch((e) => console.error(`tick failed: ${(e as Error).message}`));
  }, TICK_MS);
}
