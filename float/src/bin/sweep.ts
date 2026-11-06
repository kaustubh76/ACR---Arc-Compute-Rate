/**
 * Return the test seller's takings to the treasury.
 *
 *   FLOAT_NET=arc-testnet npm run sweep
 *
 * WHY THIS EXISTS, since it looks like a convenience and is not one.
 *
 * Every paid request moves USDC one way: vault -> seller. On a local chain that
 * is free to top up, so nothing forced the question. On Arc Testnet the treasury
 * holds exactly what the faucet gave it, and a tape left running overnight walks
 * the whole balance into the seller in about five payments. What follows is not a
 * stopped tape — it is hours of `"treasury cannot cover this"`, one per tick,
 * which looks precisely like a broken product to anyone reading the dashboard in
 * the morning.
 *
 * `FloatTestSeller.sweep` is owner-only and exists for this. Sweeping turns the
 * ten dollars into a loop instead of a budget: the same money is paid, parked,
 * pulled just in time and paid again, which is also a more honest demonstration
 * than a treasury that is merely large.
 *
 * It prints the whole circuit — buffer, sleeve, seller, and their total — because
 * the total is the invariant worth watching. It should not move except by gas,
 * and a drift in it means USDC is somewhere nobody is looking.
 */
import { formatUnits, type Address } from "viem";
import { feeFor, netFromEnv, publicFor, walletFor } from "../chain.ts";
import * as A from "../artifacts.ts";
import { load } from "../deployments.ts";

const NET = netFromEnv();
const pub = publicFor(NET);
/** The seller's owner is the deployer; `sweep` is `onlyOwner`. */
const owner = walletFor(NET, "deployer");
const d = load(NET);
const U = A.MockUSDC();
const SL = A.Erc4626Sleeve();
const SELLER = A.FloatTestSeller();

/** Below this, the gas costs more than the sweep returns. */
const MIN_SWEEP = 500_000n; // $0.50

const usd = (n: bigint) => `$${formatUnits(n, 6)}`;

async function bal(who: Address): Promise<bigint> {
  return (await pub.readContract({
    address: d.usdc,
    abi: U.abi,
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}

async function sleeveValue(): Promise<bigint> {
  return (await pub.readContract({
    address: d.sleeve,
    abi: SL.abi,
    functionName: "valueUsdc",
  })) as bigint;
}

async function circuit(label: string) {
  const [buffer, seller, sleeve] = await Promise.all([bal(d.vault), bal(d.seller), sleeveValue()]);
  console.log(
    `  ${label.padEnd(7)} buffer ${usd(buffer)} · sleeve ${usd(sleeve)} · seller ${usd(seller)}` +
      ` = ${usd(buffer + sleeve + seller)}`,
  );
  return { buffer, seller, sleeve };
}

console.log(`[sweep] ${NET} — seller ${d.seller} -> vault ${d.vault}`);
const before = await circuit("before");

if (before.seller < MIN_SWEEP) {
  console.log(`  nothing to do: seller holds ${usd(before.seller)}, under the ${usd(MIN_SWEEP)} floor`);
} else {
  const hash = await owner.writeContract({
    address: d.seller,
    abi: SELLER.abi,
    functionName: "sweep",
    args: [d.vault, before.seller],
    account: owner.account!,
    chain: owner.chain,
    ...feeFor(NET),
  });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`sweep reverted: ${hash}`);
  console.log(`  swept ${usd(before.seller)} back to the treasury — ${hash}`);

  const after = await circuit("after");
  // The seller's balance became the vault's. Anything else means a leak.
  if (after.buffer !== before.buffer + before.seller) {
    throw new Error(
      `the buffer gained ${usd(after.buffer - before.buffer)} but the seller gave up ${usd(before.seller)}`,
    );
  }
  const totalBefore = before.buffer + before.sleeve + before.seller;
  const totalAfter = after.buffer + after.sleeve + after.seller;
  if (totalAfter !== totalBefore) {
    // Not fatal: the sleeve is share-priced, so its value moves on its own and a
    // unit of drift is the venue's rounding, not a loss. Said out loud anyway,
    // because an unremarked drift is how a real one goes unnoticed.
    console.log(
      `  note: the circuit totals ${usd(totalAfter)} against ${usd(totalBefore)} before` +
        ` (${usd(totalAfter - totalBefore)}) — the sleeve is share-priced and moves on its own`,
    );
  }
}
