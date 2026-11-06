import "server-only";

/* The float vault, read straight off its chain by this server.
 *
 * WHY SERVER-SIDE AND NOT IN THE BROWSER. The static dashboard at
 * `float/app/index.html` reads the same contracts from a page, which is right
 * for a standalone file a judge can open with their own addresses in the query
 * string. It is wrong here: it would put the chain id, the RPC host and three
 * contract addresses into shipping source, and `lib/mainnetOnly.test.ts` exists
 * because this terminal once served a bundle's mainnet addresses under a testnet
 * label. Reading here keeps every one of those values in the environment, where
 * one deployment's configuration cannot become another's committed literal.
 *
 * ONLY THE VAULT IS CONFIGURED. `FloatVault` exposes `prices`, `working`,
 * `reserve` and `usdc` as public getters, so the store, both sleeves and the
 * token come off the chain. Four env vars that could disagree with each other
 * became one that cannot.
 *
 * ONE REQUEST PER ROUND, NOT ONE PER READ. Arc's public RPC rate-limits
 * individual requests — measured here as `-32005 rate limit exceeded` and, on a
 * harder burst, a bare HTTP 403 — and a sequential paced read of this vault
 * took 15.6 SECONDS to first paint in a headless browser. It accepts JSON-RPC
 * BATCHING, though: seven `eth_call`s sent as one array came back in 1.02s with
 * no errors, measured 2026-11-06. So the reads are issued concurrently and
 * `batch: true` coalesces each round into a single request, which is both
 * faster and gentler on the limit than spacing them out was.
 *
 * ROUNDS, BECAUSE SOME READS NAME THE NEXT ONE'S ADDRESS. The vault's own
 * getters give up the token and both sleeves, so round one asks the vault
 * everything and round two asks those addresses what they hold. Two requests.
 *
 * A NOTE THE PREVIOUS VERSION GOT WRONG, WORTH KEEPING: it said "there is no
 * Multicall3 deployment to assume", copied from `lib/onchain.ts`, which is
 * about a different network. The canonical `0xcA11bde0…76CA11` carries 3,808
 * bytes on the chain this vault is deployed to, checked with `eth_getCode`.
 * Batching gets the same saving without an extra contract in the path, so
 * Multicall3 is unused here rather than unavailable.
 *
 * `ACR_FLOAT_RPC_GAP_MS` still paces a RETRY after a refusal, which is the only
 * place a gap still earns its keep: the node has just said we were too fast.
 */

import { createPublicClient, decodeEventLog, formatUnits, http, keccak256, toHex, type Address, type Hex } from "viem";

import type { ChainKey } from "./chainChoice";
import { accruedFrom, principalFrom } from "./floatYield";
import { isThrottled } from "./rpcErrors";
import { ERC20_ABI, SLEEVE_ABI, STORE_ABI, TELLER_ABI, VAULT_ABI, VENUE_ABI } from "./floatAbi";
import { agreesWithRecord, codeBytes, refusalName, reserveFund, revertSelector } from "./floatReserve";
import { fairMatches, pickPay, pickPull, pickReceipt, verdictOf, type WalkLog } from "./floatWalk";
import type {
  FloatAgentStanding,
  FloatPolicyView,
  FloatPrint,
  FloatSleeve,
  FloatTape,
  FloatTapeRow,
  FloatVaultState,
  FloatVerdict,
  FloatWalk,
  FloatWalkStep,
  FloatReserveFacts,
  FloatYield,
} from "./float";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

/** The chain the vault is on. One chain, because one vault.
 *
 *  Deliberately a chain KEY and not an id: the terminal's own axis is
 *  mainnet | testnet, and an id here would be a second way to say the same
 *  thing that could disagree with the first. */
function floatChain(): ChainKey {
  return process.env.ACR_FLOAT_CHAIN === "mainnet" ? "mainnet" : "testnet";
}

/** One USDC, the amount the eligibility probe offers the Teller. Never sent:
 *  the call is a staticcall and the revert is the whole answer. The figure is
 *  the one that was driven with `cast` when the refusal was first matched, kept
 *  the same so the page and that measurement are asking one question. */
const DEPOSIT_PROBE_UNITS = 1_000_000n;

/** The burn address, as the eligibility control. Nobody can claim this one is
 *  allowlisted, which is exactly why it is the right second reading. */
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;

/** Seconds in a year, the unit Morpho annualises a per-second WAD rate with.
 *  Named because a bare 31536000 beside a fee reads as a timestamp. */
const YEAR_S = 31_536_000;

const RPC_GAP_MS = (() => {
  const raw = Number(process.env.ACR_FLOAT_RPC_GAP_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 350;
})();

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** The agent preimages this deployment knows.
 *
 *  The chain stores `keccak256(name)` and cannot hand the name back, so the
 *  preimages have to come from somewhere; `float/src/seed.ts` is where the rest
 *  of the system keeps them. Env-overridable so a deployment with other agents
 *  is a configuration change rather than a code change. */
function agentNames(): string[] {
  const raw = (process.env.ACR_FLOAT_AGENTS ?? "scout,waster").split(",");
  return raw.map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 64);
}

export function agentIdOf(name: string): Hex {
  return keccak256(toHex(name));
}

/** A nonce no payment has used. Random per call, never fixed: a constant here
 *  would start answering "replayed request" the moment anyone spent with it,
 *  and a dry run would report a rung that has nothing to do with the quote. */
function freshNonce(): Hex {
  return keccak256(toHex(`${Date.now()}:${Math.random()}`));
}

/** Why this host cannot answer for this chain, or null when it can.
 *
 *  Named refusals rather than one "not configured": a visitor on the wrong
 *  network and a deployment missing its vault address are different facts, and
 *  only the first is something the reader can act on. */
export function floatConfig(chain: ChainKey): { rpc: string; vault: Address; seller?: string } | string {
  if (chain !== floatChain()) return "the float vault runs on one chain, and this is not it";
  const rpc = (process.env.ACR_FLOAT_RPC_URL ?? "").trim();
  if (!rpc) return "this host has no RPC configured for the float vault's chain";
  const vault = (process.env.ACR_FLOAT_VAULT_ADDRESS ?? "").trim();
  if (!ADDR.test(vault)) return "this host has no float vault address configured";
  const seller = (process.env.ACR_FLOAT_SELLER_ADDRESS ?? "").trim();
  return { rpc, vault: vault as Address, ...(ADDR.test(seller) ? { seller } : {}) };
}

/* One client per RPC. Keyed on the URL rather than memoized blind, because a
   client memo that ignores its argument is how a module ends up answering for
   whichever chain happened to ask first. */
const clients = new Map<string, ReturnType<typeof createPublicClient>>();
function client(rpc: string) {
  const got = clients.get(rpc);
  if (got) return got;
  const made = createPublicClient({
    /* `fetchOptions.cache` is load-bearing and not a precaution: Next patches
       global fetch, and without it viem's RPC POSTs land in the Next Data Cache,
       which serves frozen chain state. `force-dynamic` does not cover a library
       fetch; only this opt-out does. Measured on /api/onchain, where prints read
       days stale against a chain that was minutes fresh. */
    /* `batch: true` is the whole performance story: viem coalesces every
       request issued in the same tick into one JSON-RPC array. It does nothing
       for sequential awaits, which is why the reads below are concurrent. */
    transport: http(rpc, {
      batch: true,
      timeout: 12_000,
      retryCount: 1,
      fetchOptions: { cache: "no-store" },
    }),
  });
  clients.set(rpc, made);
  return made;
}

const usdc6 = (v: bigint) => Number(formatUnits(v, 6));

/** One read: the value, or why there is no value.
 *
 *  THREE OUTCOMES AND NOT TWO. A `catch` here collects two opposite facts. The
 *  reserve sleeve reverts BY DESIGN, because it ships as a null sleeve pending
 *  an allowlist, and that is news the panel must print as a banner. A throttled
 *  read is not news about the treasury at all; it is news about us. Collapsing
 *  them into `null` is what made nine throttled reads render as a treasury with
 *  no sleeves, no agents and no policy, which was readable and wrong.
 *
 *  A THROTTLE IS RETRIED AND BACKS OFF FURTHER THAN THE STEADY GAP, because the
 *  node has just said the steady gap was too fast. A revert is never retried:
 *  it will revert again, and three more calls to learn that cost the rest of
 *  the panel its budget.
 */
type Read<T> = { ok: true; value: T } | { ok: false; busy: boolean };

async function one<T>(fn: () => Promise<T>, tries = 3): Promise<Read<T>> {
  for (let i = 0; i < tries; i += 1) {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      /* No gap on the happy path any more: the reads are batched into one
         request, so spacing them would only delay the one round. The backoff
         stays on the refusal path, where the node has just told us we were
         going too fast and a retry at the same rate is the wrong answer. */
      if (!isThrottled(e)) return { ok: false, busy: false };
      await sleep(RPC_GAP_MS * (i + 2));
    }
  }
  return { ok: false, busy: true };
}

/** A sleeve's value, or why there is none. Separate from interpreting it so the
 *  read can go in the same batched round as its sibling. */
function sleeveValue(
  c: ReturnType<typeof createPublicClient>,
  addr: Read<Address>,
  note: <T>(r: Promise<Read<T>>) => Promise<Read<T>>,
): Promise<Read<bigint>> {
  if (!addr.ok || addr.value.toLowerCase() === ZERO) {
    return Promise.resolve<Read<bigint>>({ ok: false, busy: addr.ok ? false : addr.busy });
  }
  return note(one<bigint>(() => c.readContract({ address: addr.value, abi: SLEEVE_ABI, functionName: "valueUsdc" })));
}

/** `null` is read-and-not-live; `undefined` is not-read. The reserve ships as a
 *  null sleeve that reverts on purpose, so only the first earns a banner. */
function asSleeve(addr: Read<Address>, v: Read<bigint>): FloatSleeve | null | undefined {
  if (!addr.ok) return addr.busy ? undefined : null;
  if (addr.value.toLowerCase() === ZERO) return null;
  if (v.ok) return { address: addr.value, value_usdc: usdc6(v.value) };
  return v.busy ? undefined : null;
}

/* A 30s memo, keyed on the configuration that produced it. Receipts and sleeve
   values move on payments, which the keeper and the agents drive on minute
   cadences, so a window this size costs a reader nothing and costs the RPC one
   round per window per instance.

   A PARTIAL READ IS MEMOED FOR MUCH LESS. Caching a throttled answer for thirty
   seconds would hand the next visitor the same gap, and the retry that would
   have filled it never reaches the node. Same split `lib/onchain.ts` makes, for
   the same reason. */
type Memo = { at: number; key: string; data: FloatVaultState };
let memo: Memo | null = null;
const MEMO_MS = 30_000;
const PARTIAL_MEMO_MS = 6_000;

/** @param withPrints read the print store's indices too.
 *
 *  OFF BY DEFAULT, AND THE REASON IS A MEASUREMENT. Every read here is paced
 *  350ms apart because Arc's public RPC drops concurrent calls, and the prints
 *  loop is one read for the count plus three per index — ten of twenty-three on
 *  a three-model store. Measured in a headless browser against the live vault,
 *  the full read took 48 SECONDS to first paint and the surface that triggered
 *  it renders no prints at all. Reading what nothing displays is the whole cost
 *  and none of the benefit, so the caller asks for them. */
export async function readVaultState(chain: ChainKey, withPrints = false): Promise<FloatVaultState> {
  const cfg = floatConfig(chain);
  if (typeof cfg === "string") {
    /* Offer the switch only when the chain IS the problem. A host missing its
       RPC or its vault address stands down too, and sending that reader to
       another network would be a cure for a different disease. */
    const home = floatChain();
    return { status: "pending", reason: cfg, ...(chain !== home ? { switch_to: home } : {}) };
  }

  const key = `${cfg.rpc}|${cfg.vault}|${withPrints ? "prints" : "lean"}`;
  if (memo && memo.key === key) {
    const ttl = memo.data.partial ? PARTIAL_MEMO_MS : MEMO_MS;
    if (Date.now() - memo.at < ttl) return memo.data;
  }

  const c = client(cfg.rpc);
  let busy = false;
  const note = async <T>(r: Promise<Read<T>>): Promise<Read<T>> => {
    const v = await r;
    if (!v.ok && v.busy) busy = true;
    return v;
  };

  const call = <T>(functionName: string, args?: readonly unknown[]) =>
    note(
      one<T>(() =>
        c.readContract({
          address: cfg.vault,
          abi: VAULT_ABI,
          functionName,
          ...(args ? { args } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any) as Promise<T>,
      ),
    );

  /* The one read whose failure means the whole panel is unreadable. Everything
     else can be absent and say so; a vault that will not answer `paused` is not
     a vault this host can describe, and the reason depends on which failure it
     was. */
  /* ROUND ONE: everything the vault can answer about itself, issued in one
     tick so `batch: true` sends them as a single JSON-RPC array. Sequential
     awaits here would defeat the batching entirely and put us back on the rate
     limiter, one request at a time. */
  const names = agentNames();
  const [paused, policyRaw, total, receipts, guestCap, token, workingAddr, reserveAddr, storeAddr, ...agentReads] =
    await Promise.all([
      call<boolean>("paused"),
      call<readonly [number, number, number, number, number, number, number, bigint]>("policy"),
      call<bigint>("totalValueUsdc"),
      call<bigint>("receiptCount"),
      call<bigint>("guestDailyCap"),
      call<Address>("usdc"),
      call<Address>("working"),
      call<Address>("reserve"),
      withPrints ? call<Address>("prices") : Promise.resolve<Read<Address>>({ ok: false, busy: false }),
      ...names.flatMap((name) => [
        call<readonly [boolean, bigint, bigint, bigint, bigint, boolean, boolean]>("agentOf", [agentIdOf(name)]),
        call<bigint>("remaining", [agentIdOf(name)]),
      ]),
    ]);

  /* The one read whose failure means the whole panel is unreadable. Everything
     else can be absent and say so; a vault that will not answer `paused` is not
     a vault this host can describe, and the reason depends on which failure it
     was. */
  if (!paused.ok) {
    return {
      status: "pending",
      reason: paused.busy
        ? "the float vault's chain is rate limiting this host; it retries by itself"
        : "the float vault's chain did not answer this host",
    };
  }

  /* ROUND TWO: the balances held at the addresses round one just named. One
     more batched request, and it cannot be folded into the first because these
     addresses are what the first went to find out. */
  const [buffer, workingVal, reserveVal] = await Promise.all([
    token.ok
      ? note(
          one<bigint>(() =>
            c.readContract({ address: token.value, abi: ERC20_ABI, functionName: "balanceOf", args: [cfg.vault] }),
          ),
        )
      : Promise.resolve<Read<bigint>>({ ok: false, busy: false }),
    sleeveValue(c, workingAddr, note),
    sleeveValue(c, reserveAddr, note),
  ]);

  /* `null` means read and not live. `undefined` means not read. The reserve
     ships as a null sleeve that reverts on purpose, so the first is a banner
     the product needs and the second must never be drawn as one. */
  const working = asSleeve(workingAddr, workingVal);
  const reserve = asSleeve(reserveAddr, reserveVal);

  const policy: FloatPolicyView | undefined = policyRaw.ok
    ? {
        max_premium_bps: Number(policyRaw.value[0]),
        human_max_premium_bps: Number(policyRaw.value[1]),
        max_print_age_s: Number(policyRaw.value[2]),
        working_share_bps: Number(policyRaw.value[5]),
        buffer_hours: Number(policyRaw.value[6]),
        min_ticket_usdc: usdc6(policyRaw.value[7]),
      }
    : undefined;

  const agents: FloatAgentStanding[] = [];
  names.forEach((name, i) => {
    const a = agentReads[i * 2] as Read<readonly [boolean, bigint, bigint, bigint, bigint, boolean, boolean]>;
    const left = agentReads[i * 2 + 1] as Read<bigint>;
    if (!a.ok) return;
    agents.push({
      name,
      agent_id: agentIdOf(name),
      exists: a.value[0],
      daily_cap_usdc: usdc6(a.value[1]),
      spent_usdc: usdc6(a.value[2]),
      remaining_usdc: left.ok ? usdc6(left.value) : 0,
      per_request_usdc: usdc6(a.value[3]),
      frozen: a.value[5],
      guest: a.value[6],
    });
  });

  const prints = storeAddr?.ok ? await readPrints(c, storeAddr.value, policy?.max_print_age_s ?? 0, note) : [];

  const data: FloatVaultState = {
    status: "ok",
    vault: cfg.vault,
    ...(cfg.seller ? { seller: cfg.seller } : {}),
    paused: paused.value,
    ...(buffer.ok ? { buffer_usdc: usdc6(buffer.value) } : {}),
    ...(working === undefined ? {} : { working }),
    ...(reserve === undefined ? {} : { reserve }),
    ...(total.ok ? { total_usdc: usdc6(total.value) } : {}),
    ...(receipts.ok ? { receipts: Number(receipts.value) } : {}),
    ...(guestCap.ok ? { guest_daily_cap_usdc: usdc6(guestCap.value) } : {}),
    ...(policy ? { policy } : {}),
    agents,
    ...(withPrints ? { prints } : {}),
    ...(busy ? { partial: true } : {}),
  };
  memo = { at: Date.now(), key, data };
  return data;
}

/** Every index the store carries, with its newest print.
 *
 *  Names come off the chain rather than from a model list here: `nameIndex`
 *  requires a name that hashes to its own id, so the store's own answer is the
 *  preimage and there is no model literal to drift.
 *
 *  THREE ROUNDS, NOT TEN TRIPS. This was a sequential `for` loop — one
 *  `indexCount` and then three awaited reads per index, so a three-model store
 *  cost ten round trips against a rate limit shared with every other session on
 *  this machine. It predates the batching work and never got it. The ids have
 *  to come back before anything can be asked about them, so the shape is: count,
 *  then every `indexAt` at once, then every `indexName` and `latest` at once.
 *  `batch: true` collapses each round into one request. */
async function readPrints(
  c: ReturnType<typeof createPublicClient>,
  store: Address,
  maxAgeS: number,
  note: <T>(r: Promise<Read<T>>) => Promise<Read<T>>,
): Promise<FloatPrint[]> {
  const base = { address: store, abi: STORE_ABI } as const;
  const count = await note(one<bigint>(() => c.readContract({ ...base, functionName: "indexCount" })));
  if (!count.ok) return [];
  /* Capped. A store with a surprising number of indices should make this page
     slow to read, not slow to answer. */
  const n = Math.min(Number(count.value), 8);
  if (n <= 0) return [];

  const ids = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      note(one<Hex>(() => c.readContract({ ...base, functionName: "indexAt", args: [BigInt(i)] }))),
    ),
  );
  const present = ids.filter((r): r is { ok: true; value: Hex } => r.ok);

  const details = await Promise.all(
    present.flatMap((id) => [
      note(one<string>(() => c.readContract({ ...base, functionName: "indexName", args: [id.value] }))),
      note(
        one<readonly [bigint, bigint, bigint, number]>(() =>
          c.readContract({ ...base, functionName: "latest", args: [id.value] }),
        ),
      ),
    ]),
  );

  const nowS = Math.floor(Date.now() / 1000);
  const out: FloatPrint[] = [];
  present.forEach((id, i) => {
    const name = details[i * 2] as Read<string>;
    const p = details[i * 2 + 1] as Read<readonly [bigint, bigint, bigint, number]>;
    if (!p.ok) return;
    const printId = Number(p.value[1]);
    const postedAt = Number(p.value[2]);
    /* `printId == 0` is NO PRINT, not print number zero: ids start at 1. A
       paused store also reads as all zeroes, so both arrive here and both leave
       as a stale print with no price rather than as a price of nothing. */
    const age = printId === 0 ? Number.POSITIVE_INFINITY : Math.max(0, nowS - postedAt);
    out.push({
      index: id.value,
      name: name.ok ? name.value : "",
      price_usd_per_1k: printId === 0 ? 0 : Number(formatUnits(p.value[0], 18)),
      price_wad: printId === 0 ? "0" : p.value[0].toString(),
      ci_bps: Number(p.value[3]),
      print_id: printId,
      age_s: Number.isFinite(age) ? age : 0,
      stale: printId === 0 || (maxAgeS > 0 && age > maxAgeS),
    });
  });
  return out;
}

/** The chain's own answer to "would this be refused, and why".
 *
 *  Two reads before the third, and the first two are not optional: rung 9
 *  refuses a request whose `printId` is not the store's current one, so
 *  classifying against a stale id would answer "print changed; re-quote" for
 *  every quote a reader tried and the ladder would never reach the rungs it is
 *  there to show.
 */
export async function classifyQuote(
  chain: ChainKey,
  req: { agent: string; seller: string; index?: string; units: number; quoteUsdc: number },
): Promise<FloatVerdict> {
  const cfg = floatConfig(chain);
  if (typeof cfg === "string") return { status: "pending", reason: cfg };

  const c = client(cfg.rpc);
  const busy = "the float vault's chain is rate limiting this host; it retries by itself";

  const storeAddr = await one<Address>(() =>
    c.readContract({ address: cfg.vault, abi: VAULT_ABI, functionName: "prices" }),
  );
  if (!storeAddr.ok) {
    return { status: "pending", reason: storeAddr.busy ? busy : "the float vault's chain did not answer this host" };
  }

  let index = req.index as Hex | undefined;
  if (!index) {
    const first = await one<Hex>(() =>
      c.readContract({ address: storeAddr.value, abi: STORE_ABI, functionName: "indexAt", args: [0n] }),
    );
    if (!first.ok) {
      return { status: "pending", reason: first.busy ? busy : "this store carries no priced index yet" };
    }
    index = first.value;
  }

  const latest = await one<readonly [bigint, bigint, bigint, number]>(() =>
    c.readContract({ address: storeAddr.value, abi: STORE_ABI, functionName: "latest", args: [index as Hex] }),
  );
  if (!latest.ok && latest.busy) return { status: "pending", reason: busy };
  const printId = latest.ok ? latest.value[1] : 0n;

  const out = await one<readonly [string, number, bigint, bigint]>(() =>
    c.readContract({
      address: cfg.vault,
      abi: VAULT_ABI,
      functionName: "classify",
      args: [
        {
          agentId: agentIdOf(req.agent),
          seller: req.seller as Address,
          index: index as Hex,
          units: BigInt(Math.max(0, Math.round(req.units))),
          quoteTotal: BigInt(Math.round(req.quoteUsdc * 1e6)),
          printId,
          nonce: freshNonce(),
        },
      ],
    }),
  );

  if (!out.ok) {
    return { status: "pending", reason: out.busy ? busy : "the vault did not answer this dry run" };
  }
  return {
    status: "ok",
    code: Number(out.value[1]),
    chain_reason: out.value[0],
    fair_usdc: usdc6(out.value[2]),
    print_id: Number(out.value[3]),
    quote_usdc: req.quoteUsdc,
  };
}


/* --- the tape -------------------------------------------------------------

   ONE WINDOW, NOT THE WHOLE HISTORY. Arc refuses a log query wider than about
   ten thousand blocks, and every reader in this repo pages at nine thousand.
   At the measured block time that is roughly seventy-six minutes, so this is
   the recent slice and `FloatTape` carries the window it covers so the surface
   can say which. An empty tape over a known window is a fact; an empty tape
   over an unstated one is a treasury that looks idle. */

const LOG_WINDOW = 9_000n;
/** Enough to fill a screen without asking the node for a page nobody reads. */
const MAX_ROWS = 40;
/** A ceiling so a misconfigured floor cannot walk the chain forever. Twelve
 *  windows is about fifteen hours at Arc's measured block time, and the live
 *  deployment is younger than that. */
const MAX_PAGES = 12;

/** The oldest block worth walking to: the block the sleeve was created in.
 *
 *  From the environment rather than a literal, so no block number or chain
 *  detail enters shipping source. Unset, the walk still runs to its page budget
 *  and simply reports that it did not reach the start — which is what makes the
 *  yield panel withhold a gain it cannot stand behind. */
function floorBlock(): number | null {
  const raw = Number(process.env.ACR_FLOAT_FROM_BLOCK);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : null;
}

type LogRow = { args: Record<string, unknown>; blockNumber: bigint; transactionHash: string };
type Walk = { logs: LogRow[][]; from: number; to: number; reachedFloor: boolean; busy: boolean };

/** Walk `getLogs` backwards in windows the node will accept.
 *
 *  Arc refuses a range wider than about ten thousand blocks, so reach comes
 *  from paging rather than from asking for more. Newest page first, because
 *  every caller wants the newest rows and most want to stop early.
 *
 *  A REFUSED WINDOW ENDS THE WALK AND SAYS SO. `float/app/index.html` swallows
 *  a failed page with a bare `catch` and returns what it has, which reads as a
 *  complete answer and is not one; `walk.html` aborts with the range it got to.
 *  This follows the second: the span and `reachedFloor` travel with the result,
 *  so a caller can tell a short walk from a quiet chain.
 *
 *  Every spec for one page is issued in the same tick, so `batch: true`
 *  collapses the page into a single request.
 */
async function walkLogs(
  c: ReturnType<typeof createPublicClient>,
  head: bigint,
  specs: Array<{ address: Address; event: unknown }>,
  opts: { floor: number | null; enough?: (total: number) => boolean },
  note: <T>(r: Promise<Read<T>>) => Promise<Read<T>>,
): Promise<Walk> {
  const out: LogRow[][] = specs.map(() => []);
  const floor = BigInt(opts.floor ?? 0);
  /* The span to REPORT is the walk's outer bounds, not the last page's. The
     first version returned the loop variables as they stood at exit, which is
     the OLDEST page — so a walk that covered eighty thousand blocks captioned
     itself as nine thousand, and a tape showing the whole deployment claimed
     to show seventy-six minutes of it. */
  let oldest = head;
  let reachedFloor = false;
  let busy = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const to = head - BigInt(page) * LOG_WINDOW;
    if (to < floor) break;
    let from = to > LOG_WINDOW - 1n ? to - (LOG_WINDOW - 1n) : 0n;
    if (from < floor) from = floor;

    const got = await Promise.all(
      specs.map((spec) =>
        note(
          one(() =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (c as any).getLogs({ address: spec.address, event: spec.event, fromBlock: from, toBlock: to }),
          ),
        ),
      ),
    );
    if (got.some((r) => !r.ok)) {
      busy = true;
      break;
    }
    got.forEach((r, i) => out[i].push(...((r as { ok: true; value: LogRow[] }).value ?? [])));
    oldest = from;

    if (opts.floor !== null && from <= floor) {
      reachedFloor = true;
      break;
    }
    if (from === 0n) break;
    if (opts.enough?.(out.reduce((n, rows) => n + rows.length, 0))) break;
  }

  return { logs: out, from: Number(oldest), to: Number(head), reachedFloor, busy };
}

/** A receipt states its own premium; a refusal does not, but carries both
 *  numbers that make it.
 *
 *  `Denied` has no `premiumBps` field, and the first version of this printed an
 *  ellipsis there — on the one row where the number matters most. The contract's
 *  own comment says why it carries `fair` on a refusal at all: "here is what
 *  this should have cost is the whole value of refusing an overcharge rather
 *  than merely blocking it." So it is computed from the integers, in basis
 *  points, the way the chain would. */
const bps = (fair: bigint, raw: bigint): number | null => (fair > 0n ? Number(raw) : null);

const bpsOver = (quote: bigint, fair: bigint): number | null =>
  fair > 0n ? Number(((quote - fair) * 10_000n) / fair) : null;

export async function readTape(chain: ChainKey): Promise<FloatTape> {
  const cfg = floatConfig(chain);
  if (typeof cfg === "string") return { status: "pending", reason: cfg, rows: [] };

  const c = client(cfg.rpc);
  let busy = false;
  const note = async <T,>(r: Promise<Read<T>>): Promise<Read<T>> => {
    const v = await r;
    if (!v.ok && v.busy) busy = true;
    return v;
  };

  const head = await note(one<bigint>(() => c.getBlockNumber()));
  if (!head.ok) {
    return {
      status: "pending",
      reason: head.busy
        ? "the float vault's chain is rate limiting this host; it retries by itself"
        : "the float vault's chain did not answer this host",
      rows: [],
    };
  }
  const receiptEvent = VAULT_ABI.find((e) => e.type === "event" && e.name === "Receipt");
  const deniedEvent = VAULT_ABI.find((e) => e.type === "event" && e.name === "Denied");

  /* Walk back until the screen is full or the vault's own first block, instead
     of reading one window and calling it the record. One window is about
     seventy-six minutes, which on a quiet chain is two rows and reads as a
     treasury that has barely done anything. */
  const walk = await walkLogs(
    c,
    head.value,
    [
      { address: cfg.vault, event: receiptEvent },
      { address: cfg.vault, event: deniedEvent },
    ],
    { floor: floorBlock(), enough: (n) => n >= MAX_ROWS },
    note,
  );
  const [paid, refused] = walk.logs;

  const rows: FloatTapeRow[] = [];

  {
    for (const l of paid) {
      const a = l.args;
      const fair = (a.fair as bigint) ?? 0n;
      rows.push({
        kind: "paid",
        block: Number(l.blockNumber),
        tx: l.transactionHash,
        agent_id: String(a.agentId ?? ""),
        index: String(a.index ?? ""),
        quote_usdc: usdc6((a.quote as bigint) ?? 0n),
        fair_usdc: usdc6(fair),
        premium_bps: bps(fair, (a.premiumBps as bigint) ?? 0n),
        id: Number((a.id as bigint) ?? 0n),
        units: Number((a.units as bigint) ?? 0n),
        jit_funded: Boolean(a.jitFunded),
        guest: Boolean(a.guest),
        human_approved: Boolean(a.humanApproved),
      });
    }
  }

  {
    for (const l of refused) {
      const a = l.args;
      const fair = (a.fair as bigint) ?? 0n;
      rows.push({
        kind: "refused",
        block: Number(l.blockNumber),
        tx: l.transactionHash,
        agent_id: String(a.agentId ?? ""),
        index: String(a.index ?? ""),
        quote_usdc: usdc6((a.quote as bigint) ?? 0n),
        fair_usdc: usdc6(fair),
        premium_bps: bpsOver((a.quote as bigint) ?? 0n, fair),
        code: Number((a.code as number | bigint) ?? 0),
        reason: String(a.reason ?? ""),
      });
    }
  }

  /* Newest first, and a payment sorts above a refusal in the same block: the
     refusal is the thing that did not happen, so the thing that did reads
     first. */
  rows.sort((x, y) => y.block - x.block || (x.kind === y.kind ? 0 : x.kind === "paid" ? -1 : 1));

  return {
    status: "ok",
    rows: rows.slice(0, MAX_ROWS),
    from_block: walk.from,
    to_block: walk.to,
    window_blocks: Math.max(0, walk.to - walk.from + 1),
    reached_start: walk.reachedFloor,
    ...(busy || walk.busy ? { partial: true } : {}),
  };
}

/* --- what the idle float earned ------------------------------------------

   The treasury's whole premise is that money not needed this minute earns
   until the second a bill needs it. This is the number that says whether that
   was worth doing, and it is recoverable exactly because the sleeve emits its
   own cash movements. See `lib/floatYield.ts` for why it is a floor rather
   than a point estimate, and why an incomplete basis yields nothing. */

/* Memoed like the treasury read, and for longer. This one walks ten pages of
   logs to recover a cost basis, which is about seven seconds, and the basis
   only moves when the keeper rebalances — every ten minutes at most. A reader
   who reloads should not pay for that walk again. A partial answer gets a
   short window so a throttled read recovers quickly rather than sticking. */
type YieldMemo = { at: number; key: string; data: FloatYield };
let yieldMemo: YieldMemo | null = null;
const YIELD_MEMO_MS = 120_000;
const YIELD_PARTIAL_MEMO_MS = 10_000;

/** The reserve sleeve's fund, read off its own chain.
 *
 *  SIX CHEAP READS AND NOT ONE WRITE. The fund's symbol, decimals and supply,
 *  the code at both addresses, and what this treasury holds — which is zero,
 *  and saying so from a read rather than from prose is the whole point. Enough
 *  to show the fund is real and in use without claiming anything about our
 *  eligibility to touch it, which is a Circle Support queue and not on chain.
 *
 *  ITS OWN ROUTE RATHER THAN PART OF `readYield`, because that one walks
 *  thousands of blocks of sleeve events and these six would queue behind it for
 *  no reason. */
export async function readReserveFacts(chain: ChainKey): Promise<FloatReserveFacts> {
  const cfg = floatConfig(chain);
  if (typeof cfg === "string") return { status: "pending", reason: cfg };
  const fund = reserveFund(chain);
  if (!ADDR.test(fund.token)) {
    return { status: "pending", reason: "no fund address is recorded for this chain" };
  }

  const c = client(cfg.rpc);
  let busy = false;
  const note = async <T,>(r: Promise<Read<T>>): Promise<Read<T>> => {
    const v = await r;
    if (!v.ok && v.busy) busy = true;
    return v;
  };
  const token = fund.token as Address;
  const hasTeller = ADDR.test(fund.teller);

  const [sym, dec, supply, held, tokenCode, tellerCode] = await Promise.all([
    note(one<string>(() => c.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }))),
    note(one<number>(() => c.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }))),
    note(one<bigint>(() => c.readContract({ address: token, abi: ERC20_ABI, functionName: "totalSupply" }))),
    note(one<bigint>(() => c.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [cfg.vault] }))),
    note(one<string | undefined>(() => c.getBytecode({ address: token }))),
    hasTeller
      ? note(one<string | undefined>(() => c.getBytecode({ address: fund.teller as Address })))
      : Promise.resolve({ ok: false as const, busy: false }),
  ]);

  /* WOULD THE FUND TAKE OUR MONEY. Asked by attempting a deposit as a
     staticcall, because there is nothing to read: `maxDeposit(address)` hands
     back a non-zero allowance for an address that cannot deposit at all.
     Nothing is signed and nothing moves; a staticcall that reverts IS the
     answer.

     THE CONTROL IS NOT OPTIONAL. The same attempt from an address nobody could
     claim is allowlisted has to be refused the same way, or the refusal we get
     might be about our balance, our allowance, or anything else incidental —
     which would make this exactly the false green it replaces. Both or
     neither. */
  const tryDeposit = async (from: Address): Promise<string | null | undefined> => {
    if (!hasTeller) return undefined;
    try {
      await c.simulateContract({
        account: from,
        address: fund.teller as Address,
        abi: TELLER_ABI,
        functionName: "deposit",
        args: [DEPOSIT_PROBE_UNITS, from],
      });
      /* It did NOT revert, which would mean the fund accepts us. Null rather
         than a cheerful string: the caller distinguishes refused from not, and
         "we are allowlisted" is a claim that should be made by the absence of a
         refusal and nowhere else. */
      return null;
    } catch (e) {
      const sel = revertSelector(e);
      if (sel === null) busy = true;
      return refusalName(sel) ?? undefined;
    }
  };
  const [mine, control] = await Promise.all([tryDeposit(cfg.vault), tryDeposit(DEAD_ADDRESS)]);

  /* THE SUPPLY IS SCALED BY THE DECIMALS THE TOKEN ITSELF REPORTED, not by a
     constant 6. The record says 6 and the read almost always agrees, but a
     surface that hardcodes the scale would print a supply a million times wrong
     on the one day the token disagrees with the record — which is precisely the
     day `agrees_with_record` exists to flag. */
  const scale = dec.ok ? 10 ** dec.value : 1e6;
  const symbol = sym.ok ? sym.value : null;
  const decimals = dec.ok ? dec.value : null;

  return {
    status: "ok",
    token: fund.token,
    ...(hasTeller ? { teller: fund.teller } : {}),
    symbol,
    decimals,
    supply: supply.ok ? Number(supply.value) / scale : null,
    held: held.ok ? Number(held.value) / scale : null,
    token_code_bytes: tokenCode.ok ? codeBytes(tokenCode.value) : null,
    teller_code_bytes: hasTeller && tellerCode.ok ? codeBytes(tellerCode.value) : null,
    agrees_with_record: agreesWithRecord(symbol, decimals),
    /* `undefined` collapses to not-read on the wire; a real refusal carries its
       name, and `null` means the deposit did not revert at all. */
    deposit_refused: mine === undefined ? null : mine !== null,
    deposit_refusal: mine ?? null,
    control_refusal: control ?? null,
    ...(busy ? { reason: "the chain is rate limiting this host; it retries by itself" } : {}),
  };
}

export async function readYield(chain: ChainKey): Promise<FloatYield> {
  const cfg = floatConfig(chain);
  if (typeof cfg === "string") return { status: "pending", reason: cfg };

  const memoKey = `${cfg.rpc}|${cfg.vault}`;
  if (yieldMemo && yieldMemo.key === memoKey) {
    const ttl = yieldMemo.data.complete && !yieldMemo.data.partial ? YIELD_MEMO_MS : YIELD_PARTIAL_MEMO_MS;
    if (Date.now() - yieldMemo.at < ttl) return yieldMemo.data;
  }

  const c = client(cfg.rpc);
  let busy = false;
  const note = async <T,>(r: Promise<Read<T>>): Promise<Read<T>> => {
    const v = await r;
    if (!v.ok && v.busy) busy = true;
    return v;
  };
  const stuck = "the float vault's chain is rate limiting this host; it retries by itself";

  /* Round one: which sleeve, and where the head is. The sleeve address comes
     off the vault rather than from configuration, so a sleeve swap cannot
     leave this reading a stale address. */
  const [head, sleeveAddr] = await Promise.all([
    note(one<bigint>(() => c.getBlockNumber())),
    note(one<Address>(() => c.readContract({ address: cfg.vault, abi: VAULT_ABI, functionName: "working" }))),
  ]);
  if (!head.ok || !sleeveAddr.ok) {
    /* Narrowed one at a time: an `||` over two discriminated unions does not
       tell the compiler which side failed. */
    const throttled = (!head.ok && head.busy) || (!sleeveAddr.ok && sleeveAddr.busy);
    return { status: "pending", reason: throttled ? stuck : "the chain did not answer this host" };
  }
  if (sleeveAddr.value.toLowerCase() === ZERO) {
    return { status: "pending", reason: "this treasury has no working sleeve, so nothing is earning" };
  }

  /* Round two: the live mark and the venue behind it. */
  const [value, venue] = await Promise.all([
    note(one<bigint>(() => c.readContract({ address: sleeveAddr.value, abi: SLEEVE_ABI, functionName: "valueUsdc" }))),
    note(one<Address>(() => c.readContract({ address: sleeveAddr.value, abi: SLEEVE_ABI, functionName: "venue" }))),
  ]);
  if (!value.ok) {
    return { status: "pending", reason: value.busy ? stuck : "the sleeve would not value itself" };
  }

  /* Round two and a half: what we are trusting in order to get the money back.
     Eight cheap views on the venue, batched into one round because the client
     collapses same-tick calls, and ahead of the walk rather than beside it so
     they are not competing with eighty log pages for the same rate limit.

     EVERY ONE KEEPS ITS THIRD OUTCOME. `one()` returns read-or-busy and the
     booleans stay `null` when the chain did not answer, because the collapse
     of a throttled read into `false` would put "the venue has closed our exit"
     on screen on the strength of a rate limit. That is the one sentence here
     worth being slow about. */
  const trust = venue.ok
    ? await (async () => {
        const v = venue.value;
        const gate = (fn: "canReceiveShares" | "canSendShares" | "canReceiveAssets" | "canSendAssets") =>
          note(one<boolean>(() => c.readContract({ address: v, abi: VENUE_ABI, functionName: fn, args: [sleeveAddr.value] })));
        const [rs, ss, ra, sa, pf, pfTo, mf, mfTo] = await Promise.all([
          gate("canReceiveShares"),
          gate("canSendShares"),
          gate("canReceiveAssets"),
          gate("canSendAssets"),
          note(one<bigint>(() => c.readContract({ address: v, abi: VENUE_ABI, functionName: "performanceFee" }))),
          note(one<Address>(() => c.readContract({ address: v, abi: VENUE_ABI, functionName: "performanceFeeRecipient" }))),
          note(one<bigint>(() => c.readContract({ address: v, abi: VENUE_ABI, functionName: "managementFee" }))),
          note(one<Address>(() => c.readContract({ address: v, abi: VENUE_ABI, functionName: "managementFeeRecipient" }))),
        ]);
        return {
          gates: {
            receive_shares: rs.ok ? rs.value : null,
            send_shares: ss.ok ? ss.value : null,
            receive_assets: ra.ok ? ra.value : null,
            send_assets: sa.ok ? sa.value : null,
          },
          /* A WAD share of interest. */
          performance_fee_pct: pf.ok ? (Number(pf.value) / 1e18) * 100 : null,
          /* A WAD rate PER SECOND, so a year is the only unit it means
             anything in. Morpho annualises with exactly this constant. */
          management_fee_pct_year: mf.ok ? ((Number(mf.value) * YEAR_S) / 1e18) * 100 : null,
          ...(pfTo.ok && pfTo.value.toLowerCase() !== ZERO ? { performance_fee_recipient: pfTo.value } : {}),
          ...(mfTo.ok && mfTo.value.toLowerCase() !== ZERO ? { management_fee_recipient: mfTo.value } : {}),
        };
      })()
    : null;

  /* Round three onwards: the sleeve's whole cash history. No `enough` cap —
     a basis missing its oldest deposits is worse than no basis, so this walk
     wants everything or admits it did not get it. */
  const parkedEvent = SLEEVE_ABI.find((e) => e.type === "event" && e.name === "Parked");
  const pulledEvent = SLEEVE_ABI.find((e) => e.type === "event" && e.name === "Pulled");
  const walk = await walkLogs(
    c,
    head.value,
    [
      { address: sleeveAddr.value, event: parkedEvent },
      { address: sleeveAddr.value, event: pulledEvent },
    ],
    { floor: floorBlock() },
    note,
  );
  const [parkedLogs, pulledLogs] = walk.logs;

  const parked = parkedLogs.map((l) => (l.args.usdcAmount as bigint) ?? 0n);
  /* DELIVERED, not requested: a venue may hand back less than it was asked
     for, and the contract emits both numbers precisely so this one can be the
     honest side of the subtraction. */
  const delivered = pulledLogs.map((l) => (l.args.usdcDelivered as bigint) ?? 0n);

  const principal = principalFrom(parked, delivered);
  const complete = walk.reachedFloor && !walk.busy && !busy;
  const gain = accruedFrom(value.value, principal, complete);

  const out: FloatYield = {
    status: "ok",
    sleeve: sleeveAddr.value,
    ...(venue.ok ? { venue: venue.value } : {}),
    ...(trust ?? {}),
    value_usdc: usdc6(value.value),
    principal_usdc: usdc6(principal),
    accrued_usdc: gain === null ? null : Number(gain) / 1e6,
    parked_count: parkedLogs.length,
    pulled_count: pulledLogs.length,
    from_block: walk.from,
    to_block: walk.to,
    complete,
    ...(busy || walk.busy ? { partial: true } : {}),
  };
  yieldMemo = { at: Date.now(), key: memoKey, data: out };
  return out;
}

/* --- one payment, walked -------------------------------------------------

   ONE RECEIPT IS THE WHOLE READ. `eth_getTransactionReceipt` returns every log
   in the transaction, so the vault's `Receipt`, the sleeve's `Pulled` and the
   USDC `Transfer` to the seller all decode locally from it. Only the print
   behind step one needs a second call. So a reader opening a row costs about
   two requests and nothing is polled.

   WHY THE ORDER OF LOGS IS THE PROOF. Arc serves no `debug_traceTransaction`
   and no `trace_*`, so there is no call trace to appeal to. A just-in-time
   payment claims an ORDER, and log position inside one receipt is the only
   witness to it. */

export async function readWalk(chain: ChainKey, tx: string): Promise<FloatWalk> {
  const cfg = floatConfig(chain);
  if (typeof cfg === "string") return { status: "pending", reason: cfg };

  const c = client(cfg.rpc);
  const stuck = "the float vault's chain is rate limiting this host; it retries by itself";

  const rc = await one<{
    status: string;
    blockNumber: bigint;
    logs: Array<{ logIndex: number; address: string; topics: string[]; data: string }>;
  }>(() => c.getTransactionReceipt({ hash: tx as Hex }));
  if (!rc.ok) {
    return { status: "pending", reason: rc.busy ? stuck : "no such transaction on this chain" };
  }
  if (rc.value.status !== "success") {
    return { status: "pending", reason: "that transaction reverted, so it has no payment to walk" };
  }

  /* Decode against all three ABIs and keep whatever each log turns out to be.
     A log that matches none of them is simply not part of this story. */
  const decoded: WalkLog[] = [];
  for (const l of rc.value.logs) {
    for (const abi of [VAULT_ABI, SLEEVE_ABI, ERC20_ABI]) {
      try {
        const ev = decodeEventLog({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          abi: abi as any,
          data: l.data as Hex,
          topics: l.topics as [Hex, ...Hex[]],
        }) as { eventName: string; args?: Record<string, unknown> };
        decoded.push({
          idx: Number(l.logIndex),
          addr: l.address,
          name: String(ev.eventName),
          args: (ev.args ?? {}) as Record<string, unknown>,
        });
        break;
      } catch {
        /* not this ABI's event; try the next */
      }
    }
  }

  const rcpt = pickReceipt(decoded, cfg.vault);
  if (!rcpt) return { status: "pending", reason: "that transaction carries no payment from this vault" };
  const a = rcpt.args;
  const seller = String(a.seller ?? "");
  const quote = (a.quote as bigint) ?? 0n;
  const units = (a.units as bigint) ?? 0n;
  const fair = (a.fair as bigint) ?? 0n;
  const printId = Number((a.printId as bigint) ?? 0n);
  const jit = Boolean(a.jitFunded);

  /* The USDC token and the sleeve come off the chain, not from configuration:
     a vault that swapped either would otherwise be walked against the old one. */
  const [token, sleeve] = await Promise.all([
    one<Address>(() => c.readContract({ address: cfg.vault, abi: VAULT_ABI, functionName: "usdc" })),
    one<Address>(() => c.readContract({ address: cfg.vault, abi: VAULT_ABI, functionName: "working" })),
  ]);

  const pay = token.ok ? pickPay(decoded, token.value, seller, quote) : null;
  const pull = sleeve.ok ? pickPull(decoded, sleeve.value, pay?.idx ?? null) : null;
  const verdict = verdictOf(pull?.idx ?? null, pay?.idx ?? null, jit);

  /* Step one against the print the receipt itself names. `latest` covers the
     common case of a payment quoted against the current print; an older one is
     reported as not found rather than hunted through three hundred entries,
     because a walk that costs ten reads is a walk nobody opens twice. */
  const storeAddr = await one<Address>(() =>
    c.readContract({ address: cfg.vault, abi: VAULT_ABI, functionName: "prices" }),
  );
  let priceWad: bigint | null = null;
  let indexName = "";
  if (storeAddr.ok) {
    const [latest, name] = await Promise.all([
      one<readonly [bigint, bigint, bigint, number]>(() =>
        c.readContract({ address: storeAddr.value, abi: STORE_ABI, functionName: "latest", args: [a.index as Hex] }),
      ),
      one<string>(() =>
        c.readContract({ address: storeAddr.value, abi: STORE_ABI, functionName: "indexName", args: [a.index as Hex] }),
      ),
    ]);
    if (latest.ok && Number(latest.value[1]) === printId) priceWad = latest.value[0];
    if (name.ok) indexName = name.value;
  }

  const steps: FloatWalkStep[] = [
    { n: 1, state: fairMatches(priceWad, units, fair) === false ? "bad" : priceWad === null ? "none" : "ok" },
    {
      n: 2,
      state: pull ? "ok" : jit ? "bad" : "warn",
      ...(pull ? { log_index: pull.idx } : {}),
      ...(pull ? { value_usdc: usdc6((pull.args.usdcDelivered as bigint) ?? 0n) } : {}),
      ...(pull ? { requested_usdc: usdc6((pull.args.usdcRequested as bigint) ?? 0n) } : {}),
    },
    {
      n: 3,
      state: pay ? "ok" : "none",
      ...(pay ? { log_index: pay.idx } : {}),
      ...(pay ? { value_usdc: usdc6((pay.args.value as bigint) ?? 0n) } : {}),
    },
    { n: 4, state: "ok", log_index: rcpt.idx, value_usdc: usdc6(quote) },
  ];

  return {
    status: "ok",
    tx,
    block: Number(rc.value.blockNumber),
    seller,
    index_name: indexName,
    units: Number(units),
    quote_usdc: usdc6(quote),
    fair_usdc: usdc6(fair),
    print_id: printId,
    fair_matches: fairMatches(priceWad, units, fair),
    jit_funded: jit,
    guest: Boolean(a.guest),
    human_approved: Boolean(a.humanApproved),
    steps,
    verdict,
  };
}
