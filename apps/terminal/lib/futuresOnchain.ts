import "server-only";

/* Direct viem reads against the deployed ACRFutures — the connection-ladder
   tier that keeps the futures desk, tape and OI chip alive while the FastAPI
   press is cold. Mirrors the press's FuturesReader (services/index_api) via
   the shared pure codec in lib/futuresCodec.ts, and lib/onchain.ts's RPC
   discipline verbatim: plain SEQUENTIAL eth_calls ~350ms apart (the public
   Arc RPC drops parallel bursts), one crawl per 60s per instance (module
   memo), tape via one bounded eth_getLogs with adaptive span.

   Call budget per crawl: 1 seriesCount + ~3 getSeries + 3 indices × 3 desk
   calls + 1 blockNumber + 1 getLogs ≈ 15 calls ≈ 5.5s at 350ms spacing;
   worst case with the retry pass and log-span fallbacks ≈ 12s — well inside
   the route's maxDuration. */

import { createPublicClient, http } from "viem";
import { CHAIN } from "./chain";
import { INDICES } from "./indices";
import { bundleSection } from "./api";
import {
  buildDeskRow,
  decodeSeries,
  decodeTraded,
  selectSeriesForIndex,
  type RawPosition,
  type RawSeries,
  type SeriesInfo,
} from "./futuresCodec";
import type { FuturesRoster, FuturesTradeRow } from "./types";
// Note: no shouldMemo here — every failure path returns BEFORE the memo
// write, so an unread result can never reach the cache at all.
import { ok, readFailure, unread, type Read } from "./readResult";

const FUTURES_ABI = [
  {
    type: "function",
    name: "seriesCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getSeries",
    stateMutability: "view",
    inputs: [{ name: "seriesId", type: "uint256" }],
    outputs: [
      {
        name: "series",
        type: "tuple",
        components: [
          { name: "indexId", type: "bytes32" },
          { name: "expiryTs", type: "uint64" },
          { name: "multiplier", type: "uint256" },
          { name: "maker", type: "address" },
          { name: "exists", type: "bool" },
          { name: "settled", type: "bool" },
          { name: "settlementPrice", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "positionOf",
    stateMutability: "view",
    inputs: [
      { name: "seriesId", type: "uint256" },
      { name: "trader", type: "address" },
    ],
    outputs: [
      {
        name: "position",
        type: "tuple",
        components: [
          { name: "contracts", type: "int256" },
          { name: "avgPrice", type: "int256" },
          { name: "realizedPnl", type: "int256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "unrealizedPnl",
    stateMutability: "view",
    inputs: [
      { name: "seriesId", type: "uint256" },
      { name: "trader", type: "address" },
    ],
    outputs: [{ type: "int256" }],
  },
  {
    type: "function",
    name: "traderCount",
    stateMutability: "view",
    inputs: [{ name: "seriesId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const TRADED_EVENT = {
  type: "event",
  name: "Traded",
  inputs: [
    { name: "seriesId", type: "uint256", indexed: true },
    { name: "taker", type: "address", indexed: true },
    { name: "qty", type: "int256", indexed: false },
    { name: "mark", type: "uint256", indexed: false },
  ],
} as const;

const RPC_GAP_MS = 350;
/** Enumeration cap — the demo venue holds one series per index; 24 bounds a
 *  pathological roster without blowing the serverless budget. */
const MAX_SERIES = 24;
/** Per-page log windows, widest first — mirror of python `recent_trades`.
 *
 *  Arc hard-caps an `eth_getLogs` range at ~15000 blocks: measured by binary
 *  search, 14843 answers and 15000 returns 413, no matter how few logs match.
 *  So the tape's reach cannot be bought by asking for a wider window — a
 *  bigger number just fails every time. It has to be PAGED. */
const LOG_SPANS = [14000n, 2500n, 1000n];
/** How many pages back to walk when the tape hasn't filled up.
 *
 *  Arc's measured block time is 0.510s, so a page is ~1.98h and four is ~7.9h.
 *  Sized from the heartbeat's REAL cadence, not its nominal one: GitHub
 *  free-tier drops scheduled ticks, and the observed gaps were 59m, 63m, 150m
 *  and 209m. Against one 10k window the public tape was empty 39% of the
 *  time. */
const TAPE_PAGES = 4;
/** Retries for a THROTTLED (not too-wide) log window, on the same range.
 *  Shared egress gets squeezed harder than a laptop: the same query Arc served
 *  in 0.29s from a developer machine failed 4 times in 10 from Vercel. */
const LOG_RETRIES = 2;
const TAPE_LIMIT = 25;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function futuresAddress(): `0x${string}` | null {
  const addr =
    process.env.ACR_FUTURES_ADDRESS ?? bundleSection("chain")?.futures_address ?? null;
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (addr as `0x${string}`) : null;
}

function rpcUrl(): string {
  return process.env.ACR_ARC_RPC_URL ?? bundleSection("chain")?.rpc_url ?? CHAIN.rpc;
}

let clientMemo: ReturnType<typeof createPublicClient> | null = null;
function client() {
  if (!clientMemo) {
    clientMemo = createPublicClient({
      // Same load-bearing transport options as lib/onchain.ts — Next patches
      // global fetch, and without the no-store opt-out viem's RPC POSTs land
      // in the Data Cache and the route serves frozen chain state.
      transport: http(rpcUrl(), {
        timeout: 4_000,
        retryCount: 1,
        fetchOptions: { cache: "no-store" },
      }),
    });
  }
  return clientMemo;
}

/* 60s memo: the book moves on an hourly heartbeat in production, so a crawl
   per minute per instance is already generous. A PARTIAL roster (the throttle
   ate a desk even after the retry pass) is memoized briefly so the next poll
   can complete the set instead of pinning the gap. */
let memo: { at: number; partial: boolean; data: FuturesRoster } | null = null;
const MEMO_MS = 60_000;
const PARTIAL_MEMO_MS = 15_000;

/** First-seen wall-clock per fill tx — the honest "seen Ns ago" stamp the
 *  press's FuturesReader keeps; pruned to txs still inside the log window. */
const seenAt = new Map<string, number>();

/** A range the node refused for its SIZE, as opposed to refusing us.
 *
 *  413 (and JSON-RPC -32602) mean the window was too wide, and a narrower one
 *  is the cure. 429 means there were too many requests, and narrowing cures
 *  nothing — it just walks the cursor forward a few hundred blocks per attempt
 *  and destroys the tape's reach. Mirrors python `_is_range_error`. */
function isRangeError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  if (/429|Too Many Requests/i.test(msg)) return false;
  return /413|Payload Too Large|-32602|exceeds max results|limit exceeded/i.test(msg);
}

/** One page of `Traded` logs. Explicit numeric toBlock: the Arc RPC 413s wide
 *  ranges that end at the string "latest" but accepts the same range with a
 *  number. */
function tradedLogs(venue: `0x${string}`, fromBlock: bigint, toBlock: bigint) {
  return client().getLogs({ address: venue, event: TRADED_EVENT, fromBlock, toBlock });
}
type TradedLog = Awaited<ReturnType<typeof tradedLogs>>[number];

async function readTape(venue: `0x${string}`): Promise<FuturesTradeRow[]> {
  const latest = await client().getBlockNumber();
  await sleep(RPC_GAP_MS);

  // Walk backwards a page at a time; stop as soon as the tape is full, so a
  // busy book still costs one request and only a quiet one pays for reach.
  const collected: TradedLog[] = [];
  let end = latest;
  for (let page = 0; page < TAPE_PAGES; page += 1) {
    if (end <= 0n) break;
    let got: TradedLog[] | null = null;
    let start = end > LOG_SPANS[0] ? end - LOG_SPANS[0] : 0n;
    for (const span of LOG_SPANS) {
      start = end > span ? end - span : 0n;
      try {
        got = await tradedLogs(venue, start, end);
        break;
      } catch (e) {
        if (!isRangeError(e)) break; // throttled — narrowing is no cure
        got = null;
        await sleep(RPC_GAP_MS * 2);
      }
    }
    if (!got) break; // keep what we have rather than spend the budget
    collected.unshift(...got); // older page goes in front
    if (collected.length >= TAPE_LIMIT || start <= 0n) break;
    end = start - 1n;
    await sleep(RPC_GAP_MS);
  }

  const now = Math.floor(Date.now() / 1000);
  const rows = collected
    .slice(-TAPE_LIMIT)
    .reverse() // newest first
    .map((log) => {
      const tx = log.transactionHash ?? "";
      if (!seenAt.has(tx)) seenAt.set(tx, now);
      return decodeTraded(
        log.args.seriesId ?? 0n,
        log.args.taker ?? "",
        log.args.qty ?? 0n,
        log.args.mark ?? 0n,
        log.blockNumber ?? 0n,
        tx,
        seenAt.get(tx) ?? now,
      );
    });
  const inWindow = new Set(rows.map((r) => r.tx));
  for (const tx of seenAt.keys()) if (!inWindow.has(tx)) seenAt.delete(tx);
  return rows;
}

/* Per-trader position reads for the Public Desk — small (2 calls), memoized
   15s per (series, trader) so a polling position row costs ≤1 RPC round per
   window; the memo map is pruned so desk visitors can't grow it unbounded. */
const posMemo = new Map<string, { at: number; data: TraderPosition | null }>();
const POS_MEMO_MS = 15_000;

export interface TraderPosition {
  contracts: number;
  avg_price: number;
  upnl_usdc: number;
  realized_usdc: number;
}

/** The series' USDC-per-index-point multiplier, resolved SERVER-side.
 *
 *  Load-bearing, and the reason `readTraderPosition` takes it as an argument.
 *  `buildDeskRow` scales realized PnL by the series multiplier, so passing the
 *  placeholder 1 (as this file did) understates a reader's banked PnL by
 *  exactly the multiplier — 10x on the live series. Unrealized comes back
 *  already scaled from `unrealizedPnl`, which is why nothing looked wrong.
 *
 *  Sourced from the 60s roster memo when it is warm, so the ordinary path costs
 *  no extra RPC, and never from the client — a caller-supplied multiplier would
 *  be a caller-supplied PnL.
 */
async function seriesMultiplier(seriesId: number): Promise<Read<number>> {
  const cached = Object.values(memo?.data?.desks ?? {}).find((d) => d.series_id === seriesId);
  if (cached?.multiplier) return ok(cached.multiplier);
  const venue = futuresAddress();
  if (!venue) return unread("multiplier.novenue");
  try {
    const raw = (await client().readContract({
      address: venue,
      abi: FUTURES_ABI,
      functionName: "getSeries",
      args: [BigInt(seriesId)],
    } as never)) as unknown as RawSeries;
    const m = decodeSeries(seriesId, raw).multiplier;
    return m > 0 ? ok(m) : unread("multiplier.zero");
  } catch (e) {
    // A 1x figure is not a fallback, it is a wrong answer: buildDeskRow scales
    // realized PnL by this, so returning 1 published a reader's banked PnL at a
    // TENTH of the truth on the live 10x series, with nothing to mark it. The
    // comment here used to say "the caller must not show it" — and the caller
    // showed it. Now it cannot.
    console.error(readFailure("futures.multiplier", { series: seriesId }, e));
    return unread("multiplier");
  }
}

export async function readTraderPosition(
  seriesId: number,
  trader: `0x${string}`,
): Promise<Read<TraderPosition | null>> {
  const venue = futuresAddress();
  if (!venue) return ok(null); // no venue configured is a fact, not a failure
  const key = `${seriesId}:${trader.toLowerCase()}`;
  const hit = posMemo.get(key);
  if (hit && Date.now() - hit.at < POS_MEMO_MS) return ok(hit.data);
  let data: TraderPosition | null = null;
  try {
    const mult = await seriesMultiplier(seriesId);
    if (!mult.ok) return unread(mult.why); // never a 1x PnL
    const multiplier = mult.value;
    const pos = (await client().readContract({
      address: venue,
      abi: FUTURES_ABI,
      functionName: "positionOf",
      args: [BigInt(seriesId), trader],
    } as never)) as unknown as RawPosition;
    await sleep(RPC_GAP_MS);
    const upnl = (await client().readContract({
      address: venue,
      abi: FUTURES_ABI,
      functionName: "unrealizedPnl",
      args: [BigInt(seriesId), trader],
    } as never)) as unknown as bigint;
    const row = buildDeskRow(
      { series_id: seriesId, index_id: "", expiry_ts: 0, multiplier, maker: trader, exists: true, settled: false, settlement_price: 0 },
      pos,
      upnl,
      0n,
    );
    data = {
      contracts: row.maker_inventory,
      avg_price: row.maker_avg_price,
      upnl_usdc: row.maker_unrealized_usdc,
      // Banked PnL — computed all along, then thrown away, so a reader who had
      // closed a position saw only their paper figure.
      realized_usdc: row.maker_realized_usdc,
    };
  } catch (e) {
    // Was `data = null`, which the route served 200 and the desk rendered as
    // "flat" — telling a reader holding a position that they hold nothing.
    console.error(readFailure("desk.position", { series: seriesId, trader }, e));
    return unread("position");
  }
  if (posMemo.size > 64) {
    const oldest = [...posMemo.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) posMemo.delete(oldest[0]);
  }
  posMemo.set(key, { at: Date.now(), data });
  return ok(data);
}

/* One reader's own fills. `seriesId` and `taker` are both INDEXED on `Traded`,
   so this is a topic-filtered query the node answers cheaply — no client-side
   scan of the whole tape. Memoized per (series, trader) like the position read,
   because it is polled from the same desk row. */
const fillsMemo = new Map<string, { at: number; data: FuturesTradeRow[] }>();

export async function readTraderFills(
  seriesId: number,
  trader: `0x${string}`,
  limit = 8,
): Promise<Read<FuturesTradeRow[]>> {
  const venue = futuresAddress();
  if (!venue) return ok([]);
  const key = `${seriesId}:${trader.toLowerCase()}`;
  const hit = fillsMemo.get(key);
  if (hit && Date.now() - hit.at < POS_MEMO_MS) return ok(hit.data);

  let rows: FuturesTradeRow[] = [];
  try {
    const latest = await client().getBlockNumber();
    // The same backwards walk, span ladder and 413-vs-429 distinction as
    // readTape. Arc's getLogs limits are solved in this file; re-solving them
    // here is how a second, subtly different bug gets in.
    const collected: TradedLog[] = [];
    let end = latest;
    for (let page = 0; page < TAPE_PAGES; page += 1) {
      if (end <= 0n) break;
      let got: TradedLog[] | null = null;
      let start = end > LOG_SPANS[0] ? end - LOG_SPANS[0] : 0n;
      for (const span of LOG_SPANS) {
        start = end > span ? end - span : 0n;
        // A THROTTLE deserves a retry, not a narrower window. Narrowing is the
        // cure for 413 (the range was too wide); against 429 it just walks the
        // cursor forward a few hundred blocks and destroys the reach — measured
        // once at a 7.9h walk collapsing to 1264 blocks. So the SAME range is
        // asked again after a backoff. Measured on production before this:
        // 4 of 10 reads failed, each one costing a reader their fill history.
        let attempts = 0;
        for (;;) {
          try {
            got = (await client().getLogs({
              address: venue,
              event: TRADED_EVENT,
              args: { seriesId: BigInt(seriesId), taker: trader },
              fromBlock: start,
              toBlock: end,
            })) as TradedLog[];
            break;
          } catch (e) {
            got = null;
            if (isRangeError(e)) break; // too wide — the ladder narrows below
            if (++attempts > LOG_RETRIES) break;
            await sleep(RPC_GAP_MS * 2 * attempts);
          }
        }
        if (got) break;
        await sleep(RPC_GAP_MS);
      }
      if (!got) {
        // THE measured bug. A failed page 0 left `collected` empty and fell
        // out through the SUCCESS path, returning [] — indistinguishable from
        // "this reader has never traded" (seen on 1 of 5 production probes for
        // a wallet with four fills). A catch alone never sees this. Later
        // pages are only reach: keep what they found and stop.
        if (page === 0) {
          console.error(readFailure("desk.fills.page0", { series: seriesId, trader }));
          return unread("fills");
        }
        break;
      }
      collected.unshift(...got);
      if (collected.length >= limit || start <= 0n) break;
      end = start - 1n;
      await sleep(RPC_GAP_MS);
    }
    const now = Math.floor(Date.now() / 1000);
    rows = collected
      .slice(-limit)
      .reverse()
      .map((log) => {
        const tx = log.transactionHash ?? "";
        return decodeTraded(
          log.args.seriesId ?? 0n,
          log.args.taker ?? "",
          log.args.qty ?? 0n,
          log.args.mark ?? 0n,
          log.blockNumber ?? 0n,
          tx,
          seenAt.get(tx) ?? now,
        );
      });
  } catch (e) {
    // An unreadable window is not an empty history — this comment used to sit
    // above a line that returned one anyway.
    console.error(readFailure("desk.fills", { series: seriesId, trader }, e));
    return unread("fills");
  }
  if (fillsMemo.size > 64) {
    const oldest = [...fillsMemo.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) fillsMemo.delete(oldest[0]);
  }
  fillsMemo.set(key, { at: Date.now(), data: rows });
  return ok(rows);
}

/** Read the whole venue — desks per index plus the recent fill tape — straight
 *  from ACRFutures. Null when no venue is configured or nothing resolved (the
 *  caller then falls back to the archived bundle). */
export async function readFuturesDirect(): Promise<FuturesRoster | null> {
  const venue = futuresAddress();
  if (!venue) return null;
  if (memo && Date.now() - memo.at < (memo.partial ? PARTIAL_MEMO_MS : MEMO_MS)) {
    return memo.data;
  }

  const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    client().readContract({
      address: venue,
      abi: FUTURES_ABI,
      functionName,
      args,
    } as never) as unknown as Promise<T>;

  let count: number;
  try {
    count = Number(await read<bigint>("seriesCount"));
  } catch {
    return null; // venue unreachable — let the bundle serve
  }
  await sleep(RPC_GAP_MS);

  const series: SeriesInfo[] = [];
  let partial = false;
  for (let i = 0; i < Math.min(count, MAX_SERIES); i++) {
    try {
      series.push(decodeSeries(i, await read<RawSeries>("getSeries", [BigInt(i)])));
    } catch {
      partial = true; // throttled — selection may miss this series this crawl
    }
    await sleep(RPC_GAP_MS);
  }

  const desks: FuturesRoster["desks"] = {};

  /** The series this index should publish, or null if it should publish none.
   *
   *  `selectSeriesForIndex` falls back to a SETTLED series when it sees no live
   *  one, which is right for a complete crawl — between an expiry and the next
   *  roll a settled series genuinely is the venue's latest. It is wrong for a
   *  PARTIAL one: if the throttle ate `getSeries(1)`, "no live series" only
   *  means we never saw it, and publishing series 0 shows a dead market as the
   *  live desk. Seen on production — the tier advertised settled series 0 while
   *  series 1 had 155h to run. Publish nothing instead and let the ladder fall
   *  to the bundle, which carries the real live series. */
  const deskCandidate = (id: string): SeriesInfo | null => {
    const s = selectSeriesForIndex(series, id);
    if (!s) return null;
    return s.settled && partial ? null : s;
  };

  const readDesk = async (id: string, gap: number): Promise<boolean> => {
    const s = deskCandidate(id);
    if (!s) return true; // nothing publishable for this index — not a miss
    try {
      const sid = BigInt(s.series_id);
      const maker = s.maker as `0x${string}`;
      const pos = await read<RawPosition>("positionOf", [sid, maker]);
      await sleep(gap);
      const upnl = await read<bigint>("unrealizedPnl", [sid, maker]);
      await sleep(gap);
      const traders = await read<bigint>("traderCount", [sid]);
      desks[id] = buildDeskRow(s, pos, upnl, traders);
      return true;
    } catch {
      return false; // throttled — candidate for the retry pass
    }
  };

  for (const id of INDICES) {
    await readDesk(id, RPC_GAP_MS);
    await sleep(RPC_GAP_MS);
  }
  // Second pass at 2× gap for whatever the throttle ate (onchain.ts pattern).
  const missed = INDICES.filter((id) => !(id in desks) && deskCandidate(id) !== null);
  if (missed.length > 0 && missed.length < INDICES.length) {
    await sleep(RPC_GAP_MS * 2);
    for (const id of missed) {
      await readDesk(id, RPC_GAP_MS * 2);
      await sleep(RPC_GAP_MS * 2);
    }
  }
  partial ||= INDICES.some((id) => !(id in desks) && deskCandidate(id) !== null);

  if (Object.keys(desks).length === 0) return null;

  let trades: FuturesTradeRow[] = [];
  try {
    trades = await readTape(venue);
  } catch {
    /* tape is best-effort — desks alone still revive the surfaces */
  }

  /* The finished rounds, from the series array already crawled above — no
     extra RPC. Unlike `deskCandidate`, a partial crawl is not a reason to
     withhold these: each row is a closed, self-contained fact, and the only
     cost of a short list is that a settled round shows up one refresh late.
     Withholding, by contrast, would hide the venue's proof of settlement
     exactly when the RPC is throttled. */
  const settled: FuturesRoster["settled"] = series
    .filter((s) => s.exists && s.settled)
    .sort((a, b) => b.series_id - a.series_id)
    .map((s) => ({
      series_id: s.series_id,
      index_id: s.index_id,
      settlement_price: s.settlement_price,
      expiry_ts: s.expiry_ts,
      multiplier: s.multiplier,
      maker: s.maker,
    }));

  const data: FuturesRoster = { venue, desks, trades, settled, source: "chain" };
  memo = { at: Date.now(), partial, data };
  return data;
}
