/**
 * The two agents. One behaves; one does not.
 *
 *   FLOAT_NET=anvil npm run agents -- --once
 *   FLOAT_NET=anvil npm run agents -- --park 2     # park float first, so the
 *                                                  # next payment must pull it back
 *   FLOAT_NET=anvil npm run agents                 # loop, writing the tape
 *
 * scout  asks what things cost, quotes inside the band, and gets paid for.
 * waster quotes three times the going rate and gets refused, in English, on chain.
 *
 * NEITHER AGENT HOLDS A KEY THAT CAN MOVE MONEY. Both have a real EOA — printed
 * below, and checkable on the explorer — and both stay at exactly zero USDC
 * forever. The submitting key is the executor's, held by this process, and all
 * it can do is ask: the vault decides. That separation is the product, so this
 * script prints both agents' balances before and after every payment rather than
 * asserting the claim in prose.
 */
import { decodeEventLog, formatUnits, keccak256, toHex, type Address, type Hex } from "viem";
import { addressFor, feeFor, netFromEnv, publicFor, walletFor } from "../chain.ts";
import * as A from "../artifacts.ts";
import { load } from "../deployments.ts";
import { SEED_MODELS } from "../seed.ts";
import { indexIdFor } from "../prices.ts";

const NET = netFromEnv();
const argv = process.argv.slice(2);
const ONCE = argv.includes("--once");
const parkIdx = argv.indexOf("--park");
const PARK_TO = parkIdx >= 0 ? BigInt(Math.round(Number(argv[parkIdx + 1] ?? "2") * 1e6)) : null;
const TICK_MS = 60_000;
const UNITS = 4_000n;

const pub = publicFor(NET);
const executor = walletFor(NET, "executor");
const keeper = walletFor(NET, "keeper");
const d = load(NET);
const V = A.FloatVault();
const S = A.FloatPrintStore();
const U = A.MockUSDC();

const SCOUT = { id: keccak256(toHex("scout")), eoa: addressFor("scout") as Address };
const WASTER = { id: keccak256(toHex("waster")), eoa: addressFor("waster") as Address };

const usd = (n: bigint) => `$${formatUnits(n, 6)}`;

function nonce(): Hex {
  return keccak256(toHex(`${Date.now()}:${Math.random()}`));
}

/**
 * What the sleeve is worth, which is NOT its USDC balance: it holds ERC-4626
 * shares, so its token balance is always about zero and reading that would
 * report an empty sleeve forever.
 */
async function sleeveValue(): Promise<bigint> {
  return (await pub.readContract({
    address: d.sleeve,
    abi: (await import("../artifacts.ts")).Erc4626Sleeve().abi,
    functionName: "valueUsdc",
  })) as bigint;
}

async function balance(who: Address): Promise<bigint> {
  return (await pub.readContract({
    address: d.usdc,
    abi: U.abi,
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}

/** What the chain says this model costs right now, and which print said so. */
async function quoteFor(model: string) {
  const index = keccak256(toHex(indexIdFor(model)));
  const [priceWad, printId] = (await pub.readContract({
    address: d.printStore,
    abi: S.abi,
    functionName: "latest",
    args: [index],
  })) as [bigint, bigint, bigint, number];
  if (printId === 0n) throw new Error(`no print for ${model} — run the keeper first`);
  // The same one conversion the vault does. If these two ever disagree, the
  // agent's quote would be refused for a reason that is not the seller's fault.
  const fair = (priceWad * UNITS) / 10n ** 12n;
  return { index, printId, fair };
}

async function submit(agent: { id: Hex; eoa: Address }, model: string, quote: bigint, index: Hex, printId: bigint) {
  const req = {
    agentId: agent.id,
    seller: d.seller,
    index,
    units: UNITS,
    quoteTotal: quote,
    printId,
    nonce: nonce(),
  };

  // Ask first. `classify` is a view, so this costs nothing and tells us what
  // the chain would do — the same ladder the payment runs.
  const [reason, code] = (await pub.readContract({
    address: d.vault,
    abi: V.abi,
    functionName: "classify",
    args: [req],
  })) as [string, number, bigint, bigint];

  const hash = await executor.writeContract({
    address: d.vault,
    abi: V.abi,
    functionName: "requestSpend",
    args: [req],
    account: executor.account!,
    chain: executor.chain,
    ...feeFor(NET),
  });
  const r = await pub.waitForTransactionReceipt({ hash });

  // Read the receipt the VAULT wrote, not our own expectations: the printId it
  // was checked against, the fair total it recomputed, and whether the money
  // had to be pulled out of the yield sleeve to make the payment.
  let jit: boolean | null = null;
  let fairOnChain: bigint | null = null;
  let receiptId: bigint | null = null;
  let deniedReason: string | null = null;
  let deniedCode: number | null = null;
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi: V.abi, data: log.data, topics: log.topics });
      if (ev.eventName === "Receipt") {
        const a = ev.args as unknown as { id: bigint; fair: bigint; jitFunded: boolean };
        receiptId = a.id;
        fairOnChain = a.fair;
        jit = a.jitFunded;
      }
      // A refusal is an EVENT here, not a revert — that is the vault's whole
      // design, so the transaction succeeds either way and its events are the
      // only thing that distinguishes the two outcomes.
      if (ev.eventName === "Denied") {
        const a = ev.args as unknown as { reason: string; code: number; fair: bigint };
        deniedReason = a.reason;
        deniedCode = Number(a.code);
        fairOnChain = a.fair;
      }
    } catch {
      // not ours
    }
  }

  // `ok` IS THE RECEIPT, and nothing else.
  //
  // It used to be `r.status === "success" && code === 0`, where `code` came from
  // the `classify` view taken BEFORE the write. Both halves are true of a
  // refusal: `requestSpend` emits `Denied` rather than reverting, so the status
  // is success, and the pre-flight verdict describes a chain state that has
  // since moved on. Any change between the view and the write therefore printed
  // "PAID receipt #null ... fair $0" over a payment that never happened — which
  // an overnight tape would have repeated until morning, and which is a worse
  // failure than a refusal because it reads as the product working.
  //
  // The chain already says which it was. A `Receipt` means paid; a `Denied`
  // means refused and carries the reason in English. `classify` stays as the
  // fallback for a transaction that reverted outright and emitted neither.
  const paid = receiptId !== null;
  return {
    code: deniedCode ?? code,
    reason: deniedReason ?? reason,
    hash,
    ok: paid,
    jit,
    fairOnChain,
    receiptId,
    // True when the pre-flight and the chain disagreed: worth seeing, because it
    // is the signature of a keeper print landing mid-tick.
    raced: !paid && code === 0,
  };
}

async function park(target: bigint) {
  const hash = await keeper.writeContract({
    address: d.vault,
    abi: V.abi,
    functionName: "rebalance",
    args: [target],
    account: keeper.account!,
    chain: keeper.chain,
    ...feeFor(NET),
  });
  await pub.waitForTransactionReceipt({ hash });
  const held = await balance(d.vault);
  console.log(`parked to a ${usd(target)} buffer: vault holds ${usd(held)}, sleeve ${usd(await sleeveValue())}`);
}

async function tick(i: number) {
  const model = SEED_MODELS[i % SEED_MODELS.length]!;
  const { index, printId, fair } = await quoteFor(model);

  const before = { scout: await balance(SCOUT.eoa), waster: await balance(WASTER.eoa) };
  const heldBefore = await balance(d.vault);

  // scout quotes half a percent over fair: inside the 1% band, and not exactly
  // fair, because a seller that always quotes the benchmark to the cent is not
  // a market.
  const scoutQuote = (fair * 10_050n) / 10_000n;
  const s = await submit(SCOUT, model, scoutQuote, index, printId);
  console.log(
    `scout  ${model.padEnd(34)} fair ${usd(fair)} quote ${usd(scoutQuote)} -> ` +
      (s.ok
        ? `PAID receipt #${s.receiptId} (vault recomputed fair ${usd(s.fairOnChain ?? 0n)}` +
          `${s.jit ? ", JIT: pulled out of the yield sleeve in the same transaction" : ", from buffer"})`
        : `REFUSED (${s.reason})${s.raced ? " [pre-flight said allowed: the chain moved between the two]" : ""}`),
  );

  // waster quotes three times the going rate.
  const w = await submit(WASTER, model, fair * 3n, index, printId);
  console.log(
    `waster ${model.padEnd(34)} fair ${usd(fair)} quote ${usd(fair * 3n)} -> ${w.ok ? "PAID" : `REFUSED (${w.reason})`}`,
  );

  const after = { scout: await balance(SCOUT.eoa), waster: await balance(WASTER.eoa) };
  const heldAfter = await balance(d.vault);
  const seller = await balance(d.seller);

  console.log(
    `  agent wallets: scout ${usd(before.scout)} -> ${usd(after.scout)}, ` +
      `waster ${usd(before.waster)} -> ${usd(after.waster)}`,
  );
  console.log(
    `  vault buffer ${usd(heldBefore)} -> ${usd(heldAfter)}, sleeve ${usd(await sleeveValue())}, ` +
      `seller now holds ${usd(seller)}`,
  );

  if (after.scout !== 0n || after.waster !== 0n) {
    throw new Error("INVARIANT BROKEN: an agent wallet holds USDC");
  }
}

console.log(`[agents] ${NET}`);
console.log(`  scout  EOA ${SCOUT.eoa}`);
console.log(`  waster EOA ${WASTER.eoa}`);
if (PARK_TO !== null) await park(PARK_TO);

let i = 0;
await tick(i++);
if (!ONCE) {
  console.log(`\nticking every ${TICK_MS / 1000}s. Ctrl-C to stop.`);
  setInterval(() => {
    tick(i++).catch((e) => console.error(`tick failed: ${(e as Error).message}`));
  }, TICK_MS);
}
