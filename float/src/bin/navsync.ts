/**
 * Price the USYC stand-in at Circle's REAL NAV.
 *
 *   FLOAT_NET=arc-testnet npm run navsync
 *
 * WHAT THIS FIXES. The USYC leg's benchmark has had to carry a caveat it could
 * not remove: "benchmarking its yield would be measuring our own `setNav`". The
 * stand-in's price was a constant this repo chose — read off the live Teller
 * once, on 2026-11-06, and frozen into `SimUsyc.sol` as
 * `1_142_775_997_364_038_969`. Honest, labelled, and still ours.
 *
 * It did not have to be. Circle publishes USYC's NAV through an oracle on Arc
 * testnet, and nobody here knew the address until it was handed over:
 *
 *   Oracle        0x52b56c7642E71dc54714d879127d97cd0B3D4581  (EIP-1967 proxy)
 *     -> impl     0x61ec0f00c29e4ec8fde4f39508b001d9f0fbac17  (verified)
 *
 * It is a Chainlink-shaped feed: `latestRoundData()` returns
 * `(roundId, answer, startedAt, updatedAt, answeredInRound)` with
 * `decimals() == 18`, which is already the scale `SimUsycTeller.nav` wants. So
 * this reads Circle's answer and pushes it to the stand-in.
 *
 * AFTER THIS RUNS, THE SIMULATED PART OF THE SIMULATION IS THE PERMISSION, AND
 * ONLY THE PERMISSION. The ABI is Circle's, read from the verified
 * implementation behind their proxy. The price is Circle's, read from their
 * oracle, with the round id to prove it. What remains ours is the fund itself —
 * which holds no treasury bills, cannot model a per-address allowlist, charges
 * no subscription fee, has no redemption window and no $100,000 minimum. It is
 * still a stand-in and every surface still says so.
 *
 * WHY NO REDEPLOY. `SimUsycTeller.setNav` is public and unguarded, which was a
 * deliberate choice for a fixture and is what makes this possible without
 * touching `contracts/src`. That matters: `UsycSleeve` and `SimUsyc` are
 * verified on Blockscout, and editing even a comment in either would change the
 * metadata hash and downgrade the match from full to partial.
 *
 * The round id and `updatedAt` are printed beside the value on purpose. A NAV
 * without its round is a number nobody can check.
 */
import { parseAbiItem, formatUnits, type Address } from "viem";
import { feeFor, netFromEnv, publicFor, rpcFor, walletFor } from "../chain.ts";

const NET = netFromEnv();
const pub = publicFor(NET);

/** Circle's USYC NAV oracle on Arc testnet. Read-only, never written. */
const ORACLE = "0x52b56c7642E71dc54714d879127d97cd0B3D4581" as Address;

/**
 * The stand-in fund, deployed 2026-11-06 by `DeploySimUsyc.s.sol`.
 *
 * Hardcoded here for the same reason `bench.ts` hardcodes the sleeve: it is
 * NOT in `float/deployments/arc-testnet.json`, because that file records the
 * production system and the production vault's reserve is `address(0)`. T15
 * asserts that on every run. Putting a simulated address in the deployment
 * record is how a stand-in quietly becomes part of the system.
 */
const SIM_TELLER = "0x15934AD8Ae0125935B9dBfe0a8B88A9883A04023" as Address;

const LATEST_ROUND_DATA = parseAbiItem(
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
);
const DECIMALS = parseAbiItem("function decimals() view returns (uint8)");
const NAV = parseAbiItem("function nav() view returns (uint256)");
const SET_NAV = parseAbiItem("function setNav(uint256 v)");

async function main() {
  if (NET !== "arc-testnet") {
    console.log(`[navsync] ${NET}: Circle's oracle is on arc-testnet, nothing to read here.`);
    return;
  }

  console.log(`[navsync] ${NET} — pricing the USYC stand-in at Circle's real NAV`);
  console.log(`           rpc ${rpcFor(NET)}`);
  console.log(`           oracle ${ORACLE} (Circle's, read-only)`);
  console.log(`           stand-in ${SIM_TELLER} (ours)\n`);

  const [roundId, answer, , updatedAt] = (await pub.readContract({
    address: ORACLE, abi: [LATEST_ROUND_DATA], functionName: "latestRoundData",
  })) as readonly [bigint, bigint, bigint, bigint, bigint];

  const dp = (await pub.readContract({
    address: ORACLE, abi: [DECIMALS], functionName: "decimals",
  })) as number;

  // A negative or zero answer is not a NAV. The feed's `answer` is `int256`
  // because Chainlink's shape allows signed values, and a share price that is
  // not strictly positive would make every conversion in the sleeve nonsense.
  if (answer <= 0n) {
    throw new Error(`oracle answered ${answer}, which is not a share price`);
  }
  // `SimUsycTeller.nav` is 18-decimal USDC per USYC. If Circle ever publishes
  // this feed at another scale, converting silently would be worse than
  // stopping: the stand-in would price a position at 10^n times the truth.
  if (dp !== 18) {
    throw new Error(`oracle reports ${dp} decimals; SimUsycTeller.nav expects 18 — refusing to guess`);
  }

  const ageS = Math.floor(Date.now() / 1000) - Number(updatedAt);
  console.log(`  Circle's answer   ${answer}  (${formatUnits(answer, 18)} USDC per USYC)`);
  console.log(`  round             ${roundId}`);
  console.log(`  updatedAt         ${updatedAt} — ${new Date(Number(updatedAt) * 1000).toISOString()}, ${ageS}s ago`);

  const before = (await pub.readContract({
    address: SIM_TELLER, abi: [NAV], functionName: "nav",
  })) as bigint;
  console.log(`\n  stand-in nav was  ${before}  (${formatUnits(before, 18)})`);

  if (before === answer) {
    console.log("  already Circle's number — nothing to send.");
    return;
  }

  const wallet = walletFor(NET, "deployer");
  const hash = await wallet.writeContract({
    address: SIM_TELLER, abi: [SET_NAV], functionName: "setNav", args: [answer],
    account: wallet.account!, chain: wallet.chain, ...feeFor(NET),
  });
  const rc = await pub.waitForTransactionReceipt({ hash });

  // MEASURE, DO NOT ASSUME — the rule this repo applies to sleeves, applied to
  // its own writes. A receipt means mined, not that the value took.
  const after = (await pub.readContract({
    address: SIM_TELLER, abi: [NAV], functionName: "nav",
  })) as bigint;

  console.log(`  stand-in nav now  ${after}  (${formatUnits(after, 18)})`);
  console.log(`  tx ${hash} — ${rc.status}`);

  if (after !== answer) {
    throw new Error(`setNav did not take: wanted ${answer}, read back ${after}`);
  }
  console.log(
    `\n  The stand-in now prices at Circle's round ${roundId}. The ABI is theirs,`
    + `\n  the price is theirs, and what stays simulated is the PERMISSION: the real`
    + `\n  Teller reverts NotPermissioned() for us because we hold no entitlement`
    + `\n  roles. That is what the support ticket is for, and T15 reports it live.`,
  );
}

main().catch((e) => {
  console.error(`navsync failed: ${(e as Error).message}`);
  process.exit(1);
});
