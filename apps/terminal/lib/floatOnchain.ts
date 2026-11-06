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

import { createPublicClient, formatUnits, http, keccak256, toHex, type Address, type Hex } from "viem";

import type { ChainKey } from "./chainChoice";
import { isThrottled } from "./rpcErrors";
import { ERC20_ABI, SLEEVE_ABI, STORE_ABI, VAULT_ABI } from "./floatAbi";
import type {
  FloatAgentStanding,
  FloatPolicyView,
  FloatPrint,
  FloatSleeve,
  FloatVaultState,
  FloatVerdict,
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
  if (typeof cfg === "string") return { status: "pending", reason: cfg };

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
 *  preimage and there is no model literal to drift. */
async function readPrints(
  c: ReturnType<typeof createPublicClient>,
  store: Address,
  maxAgeS: number,
  note: <T>(r: Promise<Read<T>>) => Promise<Read<T>>,
): Promise<FloatPrint[]> {
  const base = { address: store, abi: STORE_ABI } as const;
  const count = await note(one<bigint>(() => c.readContract({ ...base, functionName: "indexCount" })));
  if (!count.ok) return [];
  const n = Number(count.value);
  const nowS = Math.floor(Date.now() / 1000);
  const out: FloatPrint[] = [];
  /* Capped. A store with a surprising number of indices should make this page
     slow to read, not slow to answer. */
  for (let i = 0; i < Math.min(n, 8); i += 1) {
    const id = await note(one<Hex>(() => c.readContract({ ...base, functionName: "indexAt", args: [BigInt(i)] })));
    if (!id.ok) continue;
    const name = await note(one<string>(() => c.readContract({ ...base, functionName: "indexName", args: [id.value] })));
    const p = await note(
      one<readonly [bigint, bigint, bigint, number]>(() =>
        c.readContract({ ...base, functionName: "latest", args: [id.value] }),
      ),
    );
    if (!p.ok) continue;
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
      ci_bps: Number(p.value[3]),
      print_id: printId,
      age_s: Number.isFinite(age) ? age : 0,
      stale: printId === 0 || (maxAgeS > 0 && age > maxAgeS),
    });
  }
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
