/**
 * English in, policy on chain.
 *
 *   FLOAT_NET=anvil npm run policy                    # apply policy.config.json
 *   FLOAT_NET=anvil npm run policy -- --check         # validate only, touch nothing
 *   FLOAT_NET=anvil npm run policy -- --file other.json
 *
 * The treasurer never writes Solidity and never writes a transaction. They
 * write a sentence in Arc Studio; Studio emits JSON against
 * `float/policy.schema.json`; this applies it.
 *
 * VALIDATION IS ALL OR NOTHING, and that is the safety story worth showing on
 * camera. An invalid config is refused before a single transaction is built, so
 * the chain keeps the last good policy. A half-applied policy would be worse
 * than an unchanged one: nobody could tell which rules were live.
 *
 * It also only sends what actually differs. A no-op run that rewrites every
 * field would put a `PolicyUpdated` event on chain saying nothing changed, and
 * the audit trail is only useful if an entry in it means something happened.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { feeFor, netFromEnv, publicFor, walletFor } from "../chain.ts";
import * as A from "../artifacts.ts";
import { load } from "../deployments.ts";
import { toVaultPolicy, usdcUnits, validate } from "../policy.ts";

const NET = netFromEnv();
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes("--check");
const fileIdx = argv.indexOf("--file");
const FILE =
  fileIdx >= 0
    ? argv[fileIdx + 1]!
    : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "policy.config.json");

const raw = readFileSync(FILE, "utf8");
let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  console.error(`REFUSED: ${FILE} is not valid JSON — ${(e as Error).message}`);
  console.error("The chain keeps the last good policy.");
  process.exit(1);
}

const v = validate(parsed);
if (!v.ok) {
  console.error(`REFUSED: ${FILE} is not a valid treasury policy.\n`);
  for (const e of v.errors) console.error(`  - ${e}`);
  console.error("\nNothing was sent. The chain keeps the last good policy.");
  process.exit(1);
}
const policy = v.policy;
const configHash = keccak256(toHex(JSON.stringify(parsed)));
console.log(`${FILE} is valid. config hash ${configHash}`);

if (CHECK_ONLY) {
  console.log("--check: nothing sent.");
  process.exit(0);
}

const pub = publicFor(NET);
// The policy compiler's key. `setPolicy`/`setAgent` accept the owner or the
// studio deployer; locally they are the same address.
const studio = walletFor(NET, "deployer");
const d = load(NET);
const V = A.FloatVault();

async function send(fn: string, args: unknown[]) {
  const hash = await studio.writeContract({
    address: d.vault,
    abi: V.abi,
    functionName: fn,
    args: args as never,
    account: studio.account!,
    chain: studio.chain,
    ...feeFor(NET),
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
  return hash;
}

/** No policy checkpoint on the Arc path, so the signature arguments are empty. */
const NO_SIG = [0, `0x${"00".repeat(32)}` as Hex, `0x${"00".repeat(32)}` as Hex];

const onChain = (await pub.readContract({
  address: d.vault,
  abi: V.abi,
  functionName: "policy",
})) as readonly [number, number, number, number, number, number, number, bigint];

const want = toVaultPolicy(policy);
const have = {
  maxPremiumBps: onChain[0],
  humanMaxPremiumBps: onChain[1],
  maxPrintAge: onChain[2],
  upperBandBps: onChain[3],
  lowerBandBps: onChain[4],
  workingShareBps: onChain[5],
  bufferHours: onChain[6],
  minTicketUsdc: onChain[7],
};

const policyChanged = Object.entries(want).some(
  ([k, x]) => String(x) !== String(have[k as keyof typeof have]),
);

let sent = 0;
if (policyChanged) {
  for (const [k, x] of Object.entries(want)) {
    const y = have[k as keyof typeof have];
    if (String(x) !== String(y)) console.log(`  policy.${k}: ${y} -> ${x}`);
  }
  const hash = await send("setPolicy", [want, configHash, 0n, ...NO_SIG]);
  console.log(`  setPolicy ${hash}`);
  sent += 1;
} else {
  console.log("  policy: unchanged");
}

for (const [name, a] of Object.entries(policy.agents)) {
  const id = keccak256(toHex(name));
  const cur = (await pub.readContract({
    address: d.vault,
    abi: V.abi,
    functionName: "agentOf",
    args: [id],
  })) as readonly [boolean, bigint, bigint, bigint, bigint, boolean, boolean];
  const [exists, cap, , perReq, , frozen] = cur;

  const wantCap = usdcUnits(a.dailyCapUsdc);
  const wantReq = usdcUnits(a.perRequestUsdc);
  if (!exists || cap !== wantCap || perReq !== wantReq || frozen !== a.frozen) {
    if (exists) {
      if (cap !== wantCap) console.log(`  ${name}.dailyCap: ${cap} -> ${wantCap}`);
      if (perReq !== wantReq) console.log(`  ${name}.perRequest: ${perReq} -> ${wantReq}`);
      if (frozen !== a.frozen) console.log(`  ${name}.frozen: ${frozen} -> ${a.frozen}`);
    } else {
      console.log(`  ${name}: new agent, cap ${wantCap}, threshold ${wantReq}`);
    }
    const hash = await send("setAgent", [
      id,
      wantCap,
      wantReq,
      a.frozen,
      configHash,
      0n,
      ...NO_SIG,
    ]);
    console.log(`  setAgent(${name}) ${hash}`);
    sent += 1;
  } else {
    console.log(`  ${name}: unchanged`);
  }

  for (const seller of a.allowedSellers ?? []) {
    const allowed = (await pub.readContract({
      address: d.vault,
      abi: V.abi,
      functionName: "allowedSeller",
      args: [id, seller as Address],
    })) as boolean;
    if (!allowed) {
      const hash = await send("allowSeller", [id, seller as Address, true, 0n, ...NO_SIG]);
      console.log(`  allowSeller(${name}, ${seller}) ${hash}`);
      sent += 1;
    }
  }
}

console.log(`\n${sent} transaction(s). The policy on chain is now the policy in that file.`);
