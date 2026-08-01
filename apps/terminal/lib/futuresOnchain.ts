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
/** Log windows, widest first — mirror of python recent_trades' fallback.
 *  10k blocks ≈ 85 min at Arc's ~0.5s cadence, deep enough that the tape
 *  still shows the hourly heartbeat's last fill. */
const LOG_SPANS = [10000n, 2500n, 1000n];
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

async function readTape(venue: `0x${string}`): Promise<FuturesTradeRow[]> {
  const latest = await client().getBlockNumber();
  await sleep(RPC_GAP_MS);
  for (const span of LOG_SPANS) {
    try {
      // Explicit numeric toBlock: the Arc RPC 413s wide ranges that end at
      // the string "latest" but accepts the same range with a number.
      const logs = await client().getLogs({
        address: venue,
        event: TRADED_EVENT,
        fromBlock: latest > span ? latest - span : 0n,
        toBlock: latest,
      });
      const now = Math.floor(Date.now() / 1000);
      const rows = logs
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
    } catch {
      await sleep(RPC_GAP_MS * 2); // node capped the range or throttled — narrow
    }
  }
  return [];
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
  const readDesk = async (id: string, gap: number): Promise<boolean> => {
    const s = selectSeriesForIndex(series, id);
    if (!s) return true; // genuinely no series for this index — not a miss
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
  const missed = INDICES.filter(
    (id) => !(id in desks) && selectSeriesForIndex(series, id) !== null,
  );
  if (missed.length > 0 && missed.length < INDICES.length) {
    await sleep(RPC_GAP_MS * 2);
    for (const id of missed) {
      await readDesk(id, RPC_GAP_MS * 2);
      await sleep(RPC_GAP_MS * 2);
    }
  }
  partial ||= INDICES.some(
    (id) => !(id in desks) && selectSeriesForIndex(series, id) !== null,
  );

  if (Object.keys(desks).length === 0) return null;

  let trades: FuturesTradeRow[] = [];
  try {
    trades = await readTape(venue);
  } catch {
    /* tape is best-effort — desks alone still revive the surfaces */
  }

  const data: FuturesRoster = { venue, desks, trades, source: "chain" };
  memo = { at: Date.now(), partial, data };
  return data;
}
