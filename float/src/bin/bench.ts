/**
 * What the yield costs to reach, measured on the live chain.
 *
 *   FLOAT_NET=arc-testnet npm run bench
 *
 * Float's claim is that idle float earns until the second it is spent. The
 * price of that claim is gas: every just-in-time payment pays to pull out of a
 * venue, and until now nobody had put a number on it. This does, by asking the
 * chain to estimate the same two calls against each sleeve's REAL counterparty.
 *
 * WHAT IS COMPARABLE HERE AND WHAT IS NOT, because the honest reading depends
 * on the distinction:
 *
 *   COMPARABLE   The gas each sleeve's pull costs today, as deployed. That is
 *                a real product number: it comes out of every payment.
 *
 *   NOT          Their yields. Morpho's is a real market rate; the USYC
 *                sleeve's counterparty is a STAND-IN we deployed, so its
 *                "return" is a constant this repo chose. Benchmarking that
 *                would be measuring our own `setNav`, which is why this file
 *                measures gas and dust and says nothing about returns.
 *
 *   A FLOOR      Every USYC figure. Our code plus a trivial counterparty is
 *                strictly cheaper than our code plus Circle's real Teller, so
 *                those numbers are a lower bound and never a prediction. The
 *                real Teller refuses us — `NotPermissioned()` — which is the
 *                whole reason the stand-in exists.
 *
 * Nothing here signs or sends. `eth_estimateGas` is a read.
 */
import { formatUnits, type Address } from "viem";
import { netFromEnv, publicFor, rpcFor } from "../chain.ts";
import * as A from "../artifacts.ts";
import { load } from "../deployments.ts";

const NET = netFromEnv();
const pub = publicFor(NET);
const d = load(NET);

/**
 * The simulated USYC stack, deployed 2026-11-06 by
 * `contracts/script/DeploySimUsyc.s.sol`.
 *
 * NOT in `deployments/arc-testnet.json` on purpose. That file records the
 * production system, and the production vault's reserve is `address(0)` —
 * acceptance check T15 asserts it on every run. Putting a simulated address in
 * the deployment record is how a stand-in quietly becomes part of the system.
 */
const SIM_USYC_SLEEVE = "0x6D2A34ed26C9e4E58062ecAb9fdD1A80E4b1972E" as Address;
/** Circle's real Teller, for the record. Never called here. */
const REAL_TELLER = "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A" as Address;

/** The amount a pull is measured at: comfortably inside both positions. */
const PROBE = 250_000n; // $0.25

const SL = A.Erc4626Sleeve();
const USYC = A.UsycSleeve();

const usd = (n: bigint) => `$${formatUnits(n, 6)}`;
const num = (n: bigint | number) => n.toLocaleString("en-US");

type Row = { what: string; morpho: bigint | null; usyc: bigint | null; note: string };

async function estimate(
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
  account: Address,
): Promise<bigint | null> {
  try {
    return await pub.estimateContractGas({
      address,
      abi: abi as never,
      functionName,
      args: args as never,
      account,
    });
  } catch (e) {
    // A sleeve holding nothing cannot be asked to pay out, and that is an
    // answer rather than a fault. Say which it was instead of printing a dash.
    const m = ((e as Error).message ?? "").split("\n")[0] ?? "";
    console.error(`  (${functionName} on ${address.slice(0, 10)}… could not be estimated: ${m.slice(0, 70)})`);
    return null;
  }
}

async function main() {
  if (NET !== "arc-testnet") {
    console.log(`[bench] ${NET}: both counterparties are deployed on arc-testnet, nothing to measure here.`);
    return;
  }

  console.log(`[bench] ${NET} — gas to reach the yield, estimated against each sleeve's real counterparty`);
  console.log(`         rpc ${rpcFor(NET)}\n`);

  // Positions first: a pull cannot be estimated against a sleeve that holds
  // nothing, and printing the position explains any gap in the table.
  const morphoValue = await estimate(d.sleeve as Address, SL.abi, "valueUsdc", [], d.vault as Address);
  const usycValue = await estimate(SIM_USYC_SLEEVE, USYC.abi, "valueUsdc", [], d.deployer as Address);

  const morphoPull = await estimate(
    d.sleeve as Address, SL.abi, "withdrawExact", [PROBE], d.vault as Address,
  );
  const usycPull = await estimate(
    SIM_USYC_SLEEVE, USYC.abi, "withdrawExact", [PROBE], d.deployer as Address,
  );

  const rows: Row[] = [
    { what: `withdrawExact(${usd(PROBE)})`, morpho: morphoPull, usyc: usycPull, note: "paid by every just-in-time payment" },
    { what: "valueUsdc()", morpho: morphoValue, usyc: usycValue, note: "read inside _fund and by totalValueUsdc" },
  ];

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad("", 28) + pad("Morpho (real Vault V2)", 24) + pad("USYC (STAND-IN fund)", 24));
  for (const r of rows) {
    console.log(
      pad("  " + r.what, 28)
        + pad(r.morpho === null ? "—" : num(r.morpho) + " gas", 24)
        + pad(r.usyc === null ? "—" : num(r.usyc) + " gas", 24)
        + r.note,
    );
  }

  if (morphoPull !== null && usycPull !== null) {
    const ratio = Number(morphoPull) / Number(usycPull);
    console.log(`\n  The pull Float actually makes costs ${ratio.toFixed(1)}x the other one.`);

    // What that is worth in the only unit the treasury spends.
    const gwei = await pub.getGasPrice();
    const cost = (g: bigint) => (g * gwei) / 10n ** 12n; // wei(18dp) -> USDC(6dp)
    console.log(
      `  At ${formatUnits(gwei, 9)} Gwei that is ${usd(cost(morphoPull))} of venue gas per pull`
        + ` against ${usd(cost(usycPull))}.`,
    );
    console.log(
      `  A payment is about $1.055, so the working sleeve's pull is roughly`
        + ` ${((Number(cost(morphoPull)) / 1_055_250) * 100).toFixed(2)}% of it.`,
    );
  }

  console.log(
    "\n  READ THESE TWO COLUMNS DIFFERENTLY. Morpho's is what it costs today."
    + "\n  USYC's is our code against a STAND-IN Teller we deployed, so it is a"
    + "\n  FLOOR and not a prediction: Circle's real Teller adds its own cost,"
    + `\n  and it refuses us anyway (${REAL_TELLER} reverts NotPermissioned()).`
    + "\n"
    + "\n  AND THE EXPENSIVE ONE IS THE RIGHT ONE TO HAVE FIRST. Morpho is"
    + "\n  permissionless with six figures of depth; USYC needs an allowlist and"
    + "\n  a $100,000 minimum. Depth and permission put Morpho in the working"
    + "\n  slot, not gas. This is the price of that choice, stated.",
  );
}

main().catch((e) => {
  console.error(`bench failed: ${(e as Error).message}`);
  process.exit(1);
});
