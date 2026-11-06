/**
 * The acceptance harness. One command that re-derives every claim Float makes.
 *
 *   FLOAT_NET=anvil npm run verify
 *   FLOAT_NET=arc-testnet npm run verify
 *
 * Exits non-zero if any check fails, and prints what it observed rather than
 * only pass/fail — a green tick nobody can audit is worth less than a number.
 *
 * ONE THING WORTH EXPLAINING: Arc's public RPC does not support
 * `debug_traceTransaction` or the `trace_` namespace at all (verified: both
 * answer `-32601 method not supported`). So the claim "the money came out of
 * the yield sleeve BEFORE the seller was paid, in the same transaction" cannot
 * be proven here by tracing internal calls. It is proven instead by LOG INDEX
 * inside one transaction receipt: the sleeve's `Pulled` event must appear at a
 * lower index than the USDC `Transfer` that pays the seller. Same transaction,
 * ordered, and checkable by anyone with an RPC — no privileged node needed.
 */
import { decodeEventLog, encodeFunctionData, keccak256, parseAbiItem, toHex, formatUnits, type Address, type Hex } from "viem";
import { addressFor, feeFor, netFromEnv, publicFor, rpcFor, walletFor } from "../chain.ts";
import * as A from "../artifacts.ts";
import { load } from "../deployments.ts";
import { SEED_MODELS } from "../seed.ts";
import { indexIdFor } from "../prices.ts";
import { validate } from "../policy.ts";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NET = netFromEnv();
const pub = publicFor(NET);
const d = load(NET);
const executor = walletFor(NET, "executor");
const keeper = walletFor(NET, "keeper");
const owner = walletFor(NET, "deployer");

const V = A.FloatVault();
const S = A.FloatPrintStore();
const U = A.MockUSDC();
const SL = A.Erc4626Sleeve();

const SCOUT = keccak256(toHex("scout"));
const GUEST = keccak256(toHex(`guest-verify-${Date.now()}`));
const SCOUT_EOA = addressFor("scout") as Address;
const UNITS = 4_000n;
const NO_SIG = [0, `0x${"00".repeat(32)}` as Hex, `0x${"00".repeat(32)}` as Hex];

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const PULLED = parseAbiItem("event Pulled(uint256 usdcRequested, uint256 usdcDelivered)");

type Result = { id: string; what: string; ok: boolean; saw: string };
const results: Result[] = [];
function check(id: string, what: string, ok: boolean, saw: string) {
  results.push({ id, what, ok, saw });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${what}\n            ${saw}`);
}

/**
 * A crash must still produce a verdict.
 *
 * Every check here prints what it OBSERVED rather than a tick, which is the
 * whole point of this harness — and an uncaught throw discarded all of it,
 * printing a viem stack trace and no "N/M checks passed" line at all. That is
 * strictly worse than a failure: a reader cannot tell whether one check broke
 * or none of them ran. So the last word is always the tally, with the error
 * named underneath it.
 */
for (const sig of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(sig, (err: unknown) => {
    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n${results.length - failed.length}/${results.length} checks passed before this run ABORTED on ${NET}.`,
    );
    if (failed.length > 0) console.log(`FAILED: ${failed.map((f) => f.id).join(", ")}`);
    // Truncated to six lines on purpose: viem attaches the whole ABI to a
    // revert, and the one line that matters is the first. This used to live in
    // a second `uncaughtException` handler further down the file — but Node
    // runs every registered listener in order and this one registers first and
    // exits, so that one could never fire. Two handlers for one event is one
    // handler and a dead one.
    const msg = ((err as Error)?.message ?? String(err)).split("\n").slice(0, 6).join("\n");
    console.log(`ABORTED: ${msg}`);
    process.exit(1);
  });
}

const usd = (n: bigint) => `$${formatUnits(n, 6)}`;
const nonce = () => keccak256(toHex(`${Date.now()}:${Math.random()}`));

async function bal(who: Address): Promise<bigint> {
  return (await pub.readContract({ address: d.usdc, abi: U.abi, functionName: "balanceOf", args: [who] })) as bigint;
}
async function sleeveValue(): Promise<bigint> {
  return (await pub.readContract({ address: d.sleeve, abi: SL.abi, functionName: "valueUsdc" })) as bigint;
}

/**
 * Did that read fail because the node was unreachable, or because the contract
 * has no such function?
 *
 * It matters, and it bit us. T0 and T14 both tolerate a venue that is not
 * Morpho Vault V2, because on anvil the double genuinely is not one. They must
 * NOT tolerate an unreachable node: with anvil listening on 8546 while this
 * file's chain definition points at 8545, T0 printed **PASS — "skipped: the
 * local double is not Morpho Vault V2"**, which is a green tick whose stated
 * reason is false. A gate wants the opposite default to a report.
 */
function unreachable(e: unknown): boolean {
  const err = e as { name?: string; message?: string };
  const s = `${err?.name ?? ""} ${err?.message ?? ""}`;
  return /HttpRequestError|HTTP request failed|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|TimeoutError|timed out/i.test(s);
}
async function latest(model: string) {
  const index = keccak256(toHex(indexIdFor(model)));
  const [priceWad, printId, postedAt, ciBps] = (await pub.readContract({
    address: d.printStore, abi: S.abi, functionName: "latest", args: [index],
  })) as [bigint, bigint, bigint, number];
  return { index, priceWad, printId, postedAt, ciBps, fair: (priceWad * UNITS) / 10n ** 12n };
}
function req(agentId: Hex, index: Hex, quote: bigint, printId: bigint, units = UNITS) {
  return { agentId, seller: d.seller, index, units, quoteTotal: quote, printId, nonce: nonce() };
}
async function classify(r: ReturnType<typeof req>) {
  return (await pub.readContract({ address: d.vault, abi: V.abi, functionName: "classify", args: [r] })) as
    [string, number, bigint, bigint];
}
async function spend(r: ReturnType<typeof req>) {
  const hash = await executor.writeContract({
    address: d.vault, abi: V.abi, functionName: "requestSpend", args: [r],
    account: executor.account!, chain: executor.chain, ...feeFor(NET),
  });
  return pub.waitForTransactionReceipt({ hash });
}
async function asOwner(fn: string, args: unknown[]) {
  const hash = await owner.writeContract({
    address: d.vault, abi: V.abi, functionName: fn, args: args as never,
    account: owner.account!, chain: owner.chain, ...feeFor(NET),
  });
  return pub.waitForTransactionReceipt({ hash });
}
async function asKeeper(fn: string, args: unknown[]) {
  const hash = await keeper.writeContract({
    address: d.vault, abi: V.abi, functionName: fn, args: args as never,
    account: keeper.account!, chain: keeper.chain, ...feeFor(NET),
  });
  return pub.waitForTransactionReceipt({ hash });
}

/**
 * Morpho Vault V2, as much of it as the sleeve's correctness depends on.
 *
 * THE GATES. A contract may hold shares here only if the transfer gates admit
 * it, and that is the only reason the just-in-time pull can be atomic at all.
 * All four gate addresses are unset today. But the thing to assert is the
 * PERMISSION, not the address: `canReceiveShares` and its three siblings
 * consult the gate and answer the question we actually have. A curator who
 * installs a gate that still admits this sleeve has changed nothing we depend
 * on, and a check written against `gate == address(0)` would call that a
 * failure. See T0.
 *
 * THE TRAPS. `max*` return a constant zero — note `stateMutability` is `pure`
 * on the live vault, which is only possible because the answer never depends
 * on state — and shares are 18 decimals against 6-decimal USDC. Both are
 * asserted against the live vault in T14, because a double that models them
 * only proves we still believe them.
 */
const VENUE_ABI = [
  { type: "function", name: "receiveSharesGate", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "sendSharesGate", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "receiveAssetsGate", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "sendAssetsGate", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "canReceiveShares", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "canSendShares", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "canReceiveAssets", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "canSendAssets", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "maxWithdraw", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "pure" },
  { type: "function", name: "maxDeposit", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "pure" },
  { type: "function", name: "maxMint", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "pure" },
  { type: "function", name: "maxRedeem", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "pure" },
  { type: "function", name: "convertToAssets", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "virtualShares", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalAssets", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

console.log(`[verify] ${NET} — vault ${d.vault}\n`);

// --- T0 · the yield venue still lets us in ----------------------------------
{
  const ZERO = "0x0000000000000000000000000000000000000000";
  const gates = ["receiveSharesGate", "sendSharesGate", "receiveAssetsGate", "sendAssetsGate"] as const;
  const perms = ["canReceiveShares", "canSendShares", "canReceiveAssets", "canSendAssets"] as const;
  let ok = true;
  let saw = "";
  try {
    // One Promise.all, so the transport's batching folds these into a single
    // HTTP POST instead of nine. Arc answers a burst with a bare 403.
    const probe = await Promise.all([
      ...gates.map((fn) => pub.readContract({ address: d.venue, abi: VENUE_ABI, functionName: fn })),
      ...perms.map((fn) => pub.readContract({ address: d.venue, abi: VENUE_ABI, functionName: fn, args: [d.sleeve] })),
      pub.readContract({ address: d.venue, abi: VENUE_ABI, functionName: "totalAssets" }),
    ]);
    const gateAddrs = probe.slice(0, 4).map((x) => String(x));
    const allowed = probe.slice(4, 8).map((x) => Boolean(x));
    const tvl = probe[8] as bigint;

    // THE VERDICT IS THE PERMISSION, NOT THE GATE ADDRESS. Asserting that each
    // gate is unset would redden a vault whose curator installed a gate that
    // still admits us — a change we do not depend on. `can*` asks what we need
    // to know: may this sleeve hold shares, and may it get the money back out?
    const shut = perms.filter((_, i) => !allowed[i]).map((p) => p.replace("can", ""));
    if (shut.length > 0) ok = false;

    // The largest single pull we will ever ask for is one payment.
    const biggest = (await bal(d.vault)) + (await sleeveValue());
    if (tvl < biggest) ok = false;

    const installed = gates.filter((_, i) => (gateAddrs[i] ?? ZERO).toLowerCase() !== ZERO).map((g) => g.replace("Gate", ""));
    saw = (shut.length > 0 ? `REFUSED to ${shut.join("/")}` : "sleeve may receive and send both shares and assets")
      + `; gates ${installed.length > 0 ? `installed on ${installed.join("/")} and still admit us` : "all unset"}`
      + `; venue holds ${usd(tvl)} against our ${usd(biggest)}`;
  } catch (e) {
    const why = ((e as Error).message.split("\n")[0] ?? "").slice(0, 60);
    if (unreachable(e)) {
      // Never a skip. An unanswered question is not a satisfied one.
      ok = false;
      saw = `could not reach the node to ask: ${why}`;
    } else {
      // A local double has none of these. That is not a failure, it is a
      // different venue, and saying so beats a green tick that checked nothing.
      saw = `venue does not expose Vault V2 gates (${why})`;
      ok = NET === "anvil";
      if (ok) saw = "skipped: the local double is not Morpho Vault V2";
    }
  }
  check("T0", "the yield venue still admits this sleeve and is deep enough to pull from", ok, saw);
}

// --- T1 · every print is fresh and sane -------------------------------------
{
  const now = Math.floor(Date.now() / 1000);
  const ages: string[] = [];
  let ok = true;
  for (const m of SEED_MODELS) {
    const p = await latest(m);
    if (p.printId === 0n) { ok = false; ages.push(`${m}: NO PRINT`); continue; }
    const age = now - Number(p.postedAt);
    // Sane bounds: a compute bundle between a ten-thousandth of a cent and a
    // dollar. Outside that the keeper's unit conversion is wrong, which is a
    // bug that would otherwise surface as every quote being refused.
    const sane = p.priceWad > 10_000_000_000n && p.priceWad < 10n ** 18n;
    if (age > 900 || !sane) ok = false;
    ages.push(`${m.split("/")[1]} #${p.printId} ${age}s old ci=${p.ciBps}bp`);
  }
  check("T1", "every print is under 15 minutes old and within sane bounds", ok, ages.join(" | "));
}

const gpt = await latest(SEED_MODELS[0]!);

// --- T6 (before) · the agent's wallet holds nothing -------------------------
const scoutBefore = await bal(SCOUT_EOA);

// --- T2 · a fair spend pays the seller --------------------------------------
{
  const quote = (gpt.fair * 10_050n) / 10_000n;
  const r = await spend(req(SCOUT, gpt.index, quote, gpt.printId));

  // Read what THIS transaction did, out of its own receipt.
  //
  // This used to assert `sellerAfter - sellerBefore === quote` across a pair of
  // balance reads. That is a race against the tape, which pays the same seller
  // every half hour: a tape payment landing between the two reads makes the
  // delta larger than the quote and reddens a payment that was perfectly
  // correct. The receipt is not shared with anyone.
  //
  // And the check is named "writes a receipt" while nothing here looked for
  // one, so the Receipt event is now decoded too and its own `quote` has to
  // agree. A title that claims more than the assertion is a slow leak.
  let paid = 0n;
  let receiptId: bigint | null = null;
  let receiptQuote: bigint | null = null;
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
      const a = ev.args as unknown as { to: Address; value: bigint };
      if (log.address.toLowerCase() === d.usdc.toLowerCase()
        && a.to.toLowerCase() === d.seller.toLowerCase()) paid += a.value;
    } catch { /* not a transfer */ }
    try {
      const ev = decodeEventLog({ abi: V.abi, data: log.data, topics: log.topics });
      if (ev.eventName === "Receipt") {
        const a = ev.args as unknown as { id: bigint; quote: bigint };
        receiptId = a.id;
        receiptQuote = a.quote;
      }
    } catch { /* not ours */ }
  }

  check("T2", "a fair quote pays the seller and writes a receipt",
    r.status === "success" && paid === quote && receiptId !== null && receiptQuote === quote,
    `this transaction moved ${usd(paid)} to the seller on a ${usd(quote)} quote, ` +
    `receipt #${receiptId ?? "none"} recording ${receiptQuote === null ? "nothing" : usd(receiptQuote)}`);
}

// --- T3 · an overcharge is refused, on chain, in English --------------------
{
  const r = req(SCOUT, gpt.index, gpt.fair * 3n, gpt.printId);
  const [reason, code, fair] = await classify(r);
  const rc = await spend(r);
  let denied = "";
  let paid = 0n;
  for (const log of rc.logs) {
    try {
      const ev = decodeEventLog({ abi: V.abi, data: log.data, topics: log.topics });
      if (ev.eventName === "Denied") denied = (ev.args as unknown as { reason: string }).reason;
    } catch { /* not ours */ }
    // "Nothing moves" is a claim about THIS TRANSACTION, so ask this
    // transaction. It used to be measured as the seller's balance before
    // against after — and that failed intermittently under a live tape, which
    // pays the same seller every half hour: the balance moved between the two
    // reads while the transaction under test had moved nothing at all. A
    // global balance cannot answer a question about one transaction, and the
    // receipt can.
    try {
      const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
      const a = ev.args as unknown as { to: Address; value: bigint };
      if (log.address.toLowerCase() === d.usdc.toLowerCase()
        && a.to.toLowerCase() === d.seller.toLowerCase()) paid += a.value;
    } catch { /* not a transfer */ }
  }
  check("T3", "a 3x quote is denied on chain with the fair counter-price, and nothing moves",
    reason === "quote exceeds ACR fair band" && denied === reason && paid === 0n,
    `code ${code} "${denied}" fair ${usd(fair)} vs quote ${usd(gpt.fair * 3n)}; ` +
    `this transaction moved ${usd(paid)} to the seller`);
}

// --- T4 · the daily cap refuses rather than paying the headroom -------------
{
  // One read, and KEEP THE CAP IT FINDS. This check tightens the agent's daily
  // cap so the ladder answers the rung being tested, so it must put back what
  // was there. The restore used to write a hardcoded $25, which meant the suite
  // silently overwrote whatever cap the operator had set — and it broke T5 two
  // checks later: with the cap forced back to $25 against $25.30 already spent,
  // the just-in-time payment was refused for the CAP instead of being funded
  // from the sleeve, and the failure read as the product not working.
  const [, capBefore, spentNow, perReq] = (await pub.readContract({
    address: d.vault, abi: V.abi, functionName: "agentOf", args: [SCOUT],
  })) as readonly [boolean, bigint, bigint, bigint, bigint, boolean, boolean];
  // We need a quote the CAP refuses while the per-request threshold allows it,
  // or the ladder answers the earlier rung and this proves the wrong thing.
  // So: threshold just above the quote, cap just below what the quote would
  // take the total to. The contract also requires threshold <= cap, which is
  // satisfiable only because something has already been spent — and the revert
  // when it is not is the contract refusing an unreachable threshold, correctly.
  const quote = (gpt.fair * 10_050n) / 10_000n;
  const tightCap = spentNow + quote - 1n;
  const tightReq = quote + 1n;
  await asOwner("setAgent", [SCOUT, tightCap, tightReq, false, keccak256(toHex("verify.tighten")), 0n, ...NO_SIG]);
  // RESTORE IN A `finally`, because this check leaves on-chain state behind if
  // it does not. That is not hypothetical: a run that aborted here on one of
  // Arc's failed requests left the cap at `tightCap` — one unit below what one
  // payment costs — and every later run then refused T2 and T5 for the cap
  // while the vault was working perfectly. Worse, the tightened cap SURVIVES
  // as the next run's `capBefore`, so the corruption is preserved rather than
  // noticed. The old hardcoded $25 restore hid this by always resetting to a
  // constant; reading the real value made it visible, and `finally` is what
  // actually fixes it.
  try {
    const r = req(SCOUT, gpt.index, quote, gpt.printId);
    const [reason, code] = await classify(r);
    check("T4", "a spend over the daily cap is refused, not clamped to the headroom",
      reason === "daily cap exceeded",
      `code ${code} "${reason}" on a ${usd(quote)} request with cap ${usd(tightCap)}, ` +
      `${usd(spentNow)} already spent, threshold ${usd(tightReq)} (so the cap is what refused it)`);
  } finally {
    await asOwner("setAgent", [SCOUT, capBefore, perReq, false, keccak256(toHex("verify.restore")), 0n, ...NO_SIG]);
  }
}

// --- T11 · rebalance respects the minimum ticket ----------------------------
{
  const before = await bal(d.vault);
  // A target one unit away: inside the bands and far below the minimum ticket,
  // so the keeper must do nothing. Fees must never eat the yield.
  //
  // The direction has to follow the buffer. `before - 1n` UNDERFLOWS when the
  // buffer is exactly zero, and viem then refuses to encode -1 as a uint256 —
  // which aborted this whole suite mid-run instead of failing one check. Not
  // hypothetical: T5 parks the float down to below one payment, so any run
  // whose earlier spends were refused arrives here with an empty buffer, and a
  // print older than 15 minutes is enough to cause that. `rebalance` guards
  // both directions with the same minimum ticket, so one unit either side
  // tests the same thing.
  const target = before > 0n ? before - 1n : before + 1n;
  await asKeeper("rebalance", [target]);
  const after = await bal(d.vault);
  check("T11", "a rebalance below the minimum ticket moves nothing", after === before,
    `buffer ${usd(before)} -> ${usd(after)} on a target of ${usd(target)}, one unit away`);
}

// --- T5 · just in time, proven by log order ---------------------------------
{
  const quote = (gpt.fair * 10_050n) / 10_000n;

  // Park the float BELOW one payment, so the next spend has to pull.
  //
  // Parking to "half the fair price" looked right and was not. `rebalance`
  // refuses any move smaller than `policy.minTicketUsdc` ($1) — fees must never
  // eat the yield — so when the buffer sat a little above the target, the park
  // silently did nothing, the payment came entirely out of the buffer, and this
  // check reported `jitFunded=false, shortfall $-0.25635`. A NEGATIVE shortfall:
  // the arithmetic saying the buffer already covered it. It read as the product
  // failing when the precondition had failed.
  //
  // Parking to zero makes the delta the whole buffer, which clears the ticket
  // whenever the buffer is big enough to matter, and is only attempted when the
  // buffer would otherwise cover the payment on its own.
  if ((await bal(d.vault)) >= quote) await asKeeper("rebalance", [0n]);

  const bufferBefore = await bal(d.vault);
  const sleeveBefore = await sleeveValue();

  // And say so if it still did not take, rather than measuring a payment that
  // never needed the sleeve and blaming the vault for it.
  if (bufferBefore >= quote) {
    check("T5", "the exact shortfall leaves the yield sleeve BEFORE the seller is paid, in one transaction",
      false,
      `could not set up: the buffer is ${usd(bufferBefore)} against a ${usd(quote)} payment, so nothing ` +
      `would need pulling. rebalance refuses a move below the minimum ticket, so the float could not be ` +
      `parked low enough. This is the check's own precondition, not a fault in the vault.`);
  } else {
  const rc = await spend(req(SCOUT, gpt.index, quote, gpt.printId));

  let pulledIdx = -1, payIdx = -1, jit = false, requested = 0n, delivered = 0n;
  for (const log of rc.logs) {
    if (log.address.toLowerCase() === d.sleeve.toLowerCase()) {
      try {
        const ev = decodeEventLog({ abi: [PULLED], data: log.data, topics: log.topics });
        const a = ev.args as unknown as { usdcRequested: bigint; usdcDelivered: bigint };
        requested = a.usdcRequested; delivered = a.usdcDelivered; pulledIdx = log.logIndex!;
      } catch { /* not Pulled */ }
    }
    if (log.address.toLowerCase() === d.usdc.toLowerCase()) {
      try {
        const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
        const a = ev.args as unknown as { to: Address; value: bigint };
        if (a.to.toLowerCase() === d.seller.toLowerCase()) payIdx = log.logIndex!;
      } catch { /* not Transfer */ }
    }
    try {
      const ev = decodeEventLog({ abi: V.abi, data: log.data, topics: log.topics });
      if (ev.eventName === "Receipt") jit = (ev.args as unknown as { jitFunded: boolean }).jitFunded;
    } catch { /* not ours */ }
  }
  const shortfall = quote - bufferBefore;
  // `shortfall` is derived from a buffer read taken BEFORE the spend, so a
  // keeper rebalance landing in between moves it and this equality fails on a
  // payment that was correct. The window is a second or two and it has not
  // been seen, but a red check should name its own likely cause rather than
  // leave the reader to suspect the product.
  const raced = requested !== shortfall && requested > 0n && delivered >= requested
    && pulledIdx >= 0 && payIdx >= 0 && pulledIdx < payIdx;
  check("T5", "the exact shortfall leaves the yield sleeve BEFORE the seller is paid, in one transaction",
    jit && pulledIdx >= 0 && payIdx >= 0 && pulledIdx < payIdx && requested === shortfall && delivered >= requested,
    `jitFunded=${jit}; sleeve pull at log ${pulledIdx} < payment at log ${payIdx}; ` +
    `requested ${usd(requested)} = shortfall ${usd(shortfall)}, delivered ${usd(delivered)}; ` +
    `sleeve ${usd(sleeveBefore)} -> ${usd(await sleeveValue())}` +
    (raced
      ? ` — the pull and its order are right and only the arithmetic disagrees, which is what a keeper rebalance between the buffer read and the spend looks like; re-run before suspecting the vault`
      : ""));
  }
}

// --- T6 (after) · the invariant ---------------------------------------------
{
  const after = await bal(SCOUT_EOA);
  check("T6", "the agent's own wallet held nothing before and holds nothing after",
    scoutBefore === 0n && after === 0n,
    `${SCOUT_EOA}: ${usd(scoutBefore)} before, ${usd(after)} after every payment above`);
}

// --- T7 · an invalid policy is refused before any transaction ---------------
{
  const bad = { bufferHours: 48, maxPremiumBps: 2000, humanMaxPremiumBps: 50, maxPrintAge: 1800,
    workingShareBps: 10000, agents: { scout: { dailyCapUsdc: "25", perRequestUsdc: "5", frozen: false } } };
  const before = (await pub.readContract({ address: d.vault, abi: V.abi, functionName: "policy" })) as unknown[];
  const v = validate(bad);
  const after = (await pub.readContract({ address: d.vault, abi: V.abi, functionName: "policy" })) as unknown[];
  check("T7", "an invalid policy is refused and the chain keeps the last good one",
    !v.ok && JSON.stringify(before.map(String)) === JSON.stringify(after.map(String)),
    v.ok ? "ACCEPTED, which is wrong" : `refused: ${v.errors[0]}`);
}

// --- T8 · the policy gate is off on the Arc path ----------------------------
{
  const required = (await pub.readContract({
    address: d.vault, abi: V.abi, functionName: "requirePolicyCheckpoint",
  })) as boolean;
  check("T8", "with the human gate off, a policy change lands directly", required === false,
    `requirePolicyCheckpoint=${required} — the Arc cut has zero dependency on the human gate`);
}

// --- T10 / T12 · guests get the template and only the template --------------
{
  const reg = walletFor(NET, "deployer"); // the registrar in the local wiring
  const h = await reg.writeContract({
    address: d.vault, abi: V.abi, functionName: "registerGuest", args: [GUEST],
    account: reg.account!, chain: reg.chain, ...feeFor(NET),
  });
  await pub.waitForTransactionReceipt({ hash: h });
  const [exists, cap, , perReq, , , isGuest] = (await pub.readContract({
    address: d.vault, abi: V.abi, functionName: "agentOf", args: [GUEST],
  })) as readonly [boolean, bigint, bigint, bigint, bigint, boolean, boolean];
  check("T12", "a guest gets the fixed template and cannot choose its own numbers",
    exists && isGuest && cap === 2_000_000n && perReq === 2_000_000n,
    `cap ${usd(cap)}, threshold ${usd(perReq)}, guest=${isGuest}`);

  // Over the guest template, inside the band: must be refused.
  const bigUnits = UNITS * 20n;
  const bigFair = (gpt.priceWad * bigUnits) / 10n ** 12n;
  const [reason] = await classify(req(GUEST, gpt.index, bigFair, gpt.printId, bigUnits));
  check("T10", "a guest spending over its template is refused",
    reason === "over per-request threshold" || reason === "daily cap exceeded",
    `"${reason}" on a ${usd(bigFair)} request against a ${usd(cap)} template`);
}

// --- T13 · the Eco Sauce pre-flight, asked of the venue we do not control ---
//
// Float's claim is that the exact shortfall leaves Morpho in the same
// transaction as the payment. T5 proves that it DID. This asks whether it
// WOULD, before any transaction exists — as a compiled Sauce program run
// against live Arc state.
//
// Both directions are run on purpose. A pre-flight that only ever says yes
// proves nothing, so the check fails unless the coverable amount passes AND the
// uncoverable one is refused with the program's own sentence.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "..", "sauce");
  const cli = join(dir, "node_modules", ".bin", "sauce");
  const prog = join(dir, "jit_preflight.sauce.ts");

  // `@eco-incorp/sauce` is 22 MB and proprietary, so it is NOT a dependency of
  // this package and CI never installs it. Absent, this prints why and the run
  // still passes — the same shape as T0 on anvil.
  if (NET !== "arc-testnet" || !existsSync(cli)) {
    const why = NET !== "arc-testnet"
      ? `the Sauce engine is deployed on arc-testnet, not ${NET}`
      : "the Sauce CLI is not installed — run `make float-sauce`";
    check("T13", "the Sauce pre-flight agrees with the venue about what it can deliver",
      true, `skipped: ${why}`);
  } else {
    const held = await sleeveValue();
    const run = (needed: bigint) => {
      try {
        return execFileSync(cli, [
          "simulate", prog, "--chain", "arc-testnet", "--rpc-url", rpcFor(NET),
          "--owner", d.deployer, "--args", d.venue, d.sleeve, needed.toString(),
        ], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        // A reverting cook exits non-zero; its reason is on stdout/stderr and
        // is the thing we came for, not an error.
        const x = e as { stdout?: string; stderr?: string };
        return `${x.stdout ?? ""}${x.stderr ?? ""}`;
      }
    };

    // Comfortably inside what the sleeve holds, and far outside it.
    const canDo = held / 2n;
    const cannot = held * 100n + 1_000_000n;
    const okOut = run(canDo);
    const noOut = run(cannot);

    const passed = /The cook succeeds/.test(okOut);
    const refused = /cannot cover this shortfall/.test(noOut);
    // Stated rather than assumed: Arc serves no eth_simulateV1, so Sauce falls
    // back to eth_call and says so. If that ever changes, this line changes.
    const path = /did not run eth_simulateV1/.test(okOut) ? "eth_call fallback" : "eth_simulateV1";
    check("T13", "the Sauce pre-flight agrees with the venue about what it can deliver",
      passed && refused,
      `sleeve holds ${usd(held)}: ${usd(canDo)} accepted, ${usd(cannot)} refused ` +
      `with the program's own sentence; simulated via ${path}, nothing signed`);
  }
}

// --- T14 · the venue is still the Vault V2 the sleeve was written against ---
//
// Two properties of Morpho Vault V2 break ordinary ERC-4626 code, and the
// sleeve is built around both of them. Until now they were guarded in two
// places that cannot guard them:
//
//   * `forge test` asserts them against our own MockVault4626 — which models
//     them. That proves we still believe them, not that they are still true.
//   * T13 asserts them against the live vault inside a Sauce program, and T13
//     SKIPS whenever that 22 MB proprietary CLI is absent: in CI, and in every
//     clone a judge makes.
//
// So the one property whose silent change would quietly empty the sleeve had no
// gate a stranger could run. This is that gate, and it needs nothing but an RPC.
{
  let ok = true;
  const saw: string[] = [];
  try {
    const maxes = ["maxWithdraw", "maxDeposit", "maxMint", "maxRedeem"] as const;
    // One POST again, for the same reason as T0.
    const probe = await Promise.all([
      ...maxes.map((fn) => pub.readContract({ address: d.venue, abi: VENUE_ABI, functionName: fn, args: [d.sleeve] })),
      pub.readContract({ address: d.venue, abi: VENUE_ABI, functionName: "decimals" }),
      pub.readContract({ address: d.usdc, abi: U.abi, functionName: "decimals" }),
      // One whole USDC, handed over AS IF it were a share balance.
      pub.readContract({ address: d.venue, abi: VENUE_ABI, functionName: "convertToAssets", args: [1_000_000n] }),
    ]);
    const maxOut = probe.slice(0, 4).map((x) => x as bigint);
    const vDec = Number(probe[4]);
    const uDec = Number(probe[5]);
    const asShares = probe[6] as bigint;

    // 1. Every max* lies, by design and stated in the vault's own source. A
    //    sleeve that sized a withdrawal from maxWithdraw reports an empty
    //    position forever, which is why `valueUsdc` converts the share balance.
    if (!maxOut.every((m) => m === 0n)) ok = false;
    saw.push(`${maxes.join("/")} all return ${maxOut.join("/")}`);

    // 2. Shares are 18 decimals against 6-decimal USDC, so convertToAssets
    //    must be fed a SHARE balance and never an amount. Demonstrated, not
    //    described: one whole USDC read as shares comes back as nothing.
    if (vDec <= uDec) ok = false;
    if (asShares !== 0n) ok = false;
    saw.push(`shares ${vDec}dp vs asset ${uDec}dp, so convertToAssets(1 USDC) = ${asShares}`);

    // 3. The scale itself, derived from the two decimals just read rather than
    //    written down as 1e12 and hoped for. If a constant governs a quantity,
    //    the check should name the quantity.
    const expected = 10n ** BigInt(vDec - uDec);
    try {
      const vs = (await pub.readContract({
        address: d.venue, abi: VENUE_ABI, functionName: "virtualShares",
      })) as bigint;
      if (vs !== expected) ok = false;
      saw.push(`virtualShares ${vs} = 10^(${vDec}-${uDec})`);
    } catch {
      // The local double does not expose it. The three assertions above DO hold
      // against the double, so this reports instead of skipping the whole
      // check — a check that degenerates to a skip off-chain is worth little.
      saw.push(`virtualShares not exposed here (10^(${vDec}-${uDec}) = ${expected})`);
    }
  } catch (e) {
    const why = ((e as Error).message.split("\n")[0] ?? "").slice(0, 60);
    ok = unreachable(e) ? false : NET === "anvil";
    saw.push(ok
      ? "skipped: the local double is not Morpho Vault V2"
      : unreachable(e)
        ? `could not reach the node to ask: ${why}`
        : `could not read the venue: ${why}`);
  }
  check("T14", "the venue is still Vault V2: every max* returns zero and shares are 18 decimals",
    ok, saw.join("; "));
}

// --- T15 · is the USYC reserve allowlisted yet? ----------------------------
//
// The reserve sleeve is BUILT AND TESTED BUT NOT FUNDED, and the thing in the
// way is Circle's allowlist: a support ticket with a 24-48 hour turnaround,
// not a line of code. That is a human dependency, and a human dependency left
// unchecked is how a submission ends up claiming a position it does not hold.
//
// So the suite asks the chain on every run. A staticcall of the Teller's
// `deposit` costs nothing, sends nothing, and answers exactly one question.
//
// WHY NOT `maxDeposit`, WHICH LOOKS LIKE THE OBVIOUS CHECK: because it lies.
// Measured 2026-11-06, `maxDeposit(deployer)` returned 5,723,443 — non-zero —
// for an address whose deposits revert. Anyone reading `maxDeposit > 0` as
// eligibility ships a sleeve that fails on first use.
{
  const TELLER = "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A" as Address;
  // `NotPermissioned()`, from the Teller's own verified ABI.
  const NOT_PERMISSIONED = "0x7f63bd0f";
  if (NET !== "arc-testnet") {
    check("T15", "the USYC reserve's allowlist standing is known, not assumed",
      true, `skipped: the Teller is on arc-testnet, not ${NET}`);
  } else {
    let saw = "";
    let ok = true;
    try {
      await pub.call({
        to: TELLER,
        account: addressFor("deployer") as Address,
        data: encodeFunctionData({
          abi: [{
            type: "function", name: "deposit",
            inputs: [{ type: "uint256" }, { type: "address" }],
            outputs: [{ type: "uint256" }], stateMutability: "nonpayable",
          }],
          functionName: "deposit",
          args: [1_000_000n, addressFor("deployer") as Address],
        }),
      });
      // If this ever stops reverting, the ticket has cleared and the reserve
      // can be funded. Until a human reads this line, nothing claims it has.
      saw = "ALLOWLISTED: the Teller accepted a simulated deposit. The USYC "
        + "reserve can now be funded, and the docs should stop saying it cannot.";
    } catch (e) {
      // The selector is NOT in `.message`. viem wraps the revert as
      // CallExecutionError <- ExecutionRevertedError <- RpcRequestError, and
      // only the inner one carries `.data`. Matching on the message looked
      // right, failed, and correctly refused to call an unreadable answer a
      // settled one — so walk the chain for the raw bytes instead.
      let data: string | undefined;
      for (let w: unknown = e; w && !data; w = (w as { cause?: unknown }).cause) {
        const d = (w as { data?: unknown }).data;
        if (typeof d === "string" && d.startsWith("0x")) data = d;
      }
      const m = String((e as Error).message ?? "");
      if (data?.startsWith(NOT_PERMISSIONED)) {
        saw = `not allowlisted yet: the Teller reverts NotPermissioned() (${NOT_PERMISSIONED}). `
          + "The sleeve is built and tested; funding it is a Circle support ticket.";
      } else {
        // A different error means the probe itself stopped answering, and an
        // unanswered question must not read as a settled one.
        ok = false;
        saw = `the probe did not get a legible answer: ${m.split("\n")[0]?.slice(0, 90)}`;
      }
    }
    check("T15", "the USYC reserve's allowlist standing is known, not assumed", ok, saw);
  }
}

// --- the verdict ------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed on ${NET}.`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.id).join(", ")}`);
  process.exit(1);
}
console.log("Every claim Float makes is re-derivable from this command.");
