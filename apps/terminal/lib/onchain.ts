import "server-only";

/* Direct viem reads against the deployed ACROracle — the tier of the
   connection ladder that keeps REAL settlement-grade prints on screen while
   the FastAPI press is cold. One RPC round per 30s per instance (module
   memo); the /api/onchain route adds CDN caching on top.

   Deliberately plain eth_calls rather than multicall (Arc testnet's
   Multicall3 deployment is not assumed), and deliberately SEQUENTIAL with a
   ~350ms gap: the public RPC rate-limits concurrent requests (verified —
   3 parallel reads lose 2, spaced reads succeed). The 30s memo means the
   pacing cost is paid once per window, not per visitor. */

import { createPublicClient, http } from "viem";
import { CHAIN } from "./chain";
import { INDICES } from "./indices";
import { bundleSection } from "./api";
import { decodePrint, indexIdBytes32, type RawPrint } from "./onchainCodec";
import type { HistoryPoint, OnchainDirectRead } from "./types";

const ORACLE_ABI = [
  {
    type: "function",
    name: "latestPrintWithAge",
    stateMutability: "view",
    inputs: [{ name: "indexId", type: "bytes32" }],
    outputs: [
      {
        name: "print",
        type: "tuple",
        components: [
          { name: "value", type: "uint256" },
          { name: "ciLo", type: "uint256" },
          { name: "ciHi", type: "uint256" },
          { name: "attackCostPerBp", type: "uint256" },
          { name: "timestamp", type: "uint64" },
          { name: "postedAt", type: "uint64" },
          { name: "exists", type: "bool" },
        ],
      },
      { name: "age", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "historyLength",
    stateMutability: "view",
    inputs: [{ name: "indexId", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "historyAt",
    stateMutability: "view",
    inputs: [
      { name: "indexId", type: "bytes32" },
      { name: "i", type: "uint256" },
    ],
    outputs: [
      {
        name: "print",
        type: "tuple",
        components: [
          { name: "value", type: "uint256" },
          { name: "ciLo", type: "uint256" },
          { name: "ciHi", type: "uint256" },
          { name: "attackCostPerBp", type: "uint256" },
          { name: "timestamp", type: "uint64" },
          { name: "postedAt", type: "uint64" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const;

const HISTORY_POINTS = 12;
const RPC_GAP_MS = 350;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function oracleAddress(): `0x${string}` | null {
  const fromEnv = process.env.ACR_ORACLE_ADDRESS;
  const fromBundle = bundleSection("chain")?.oracle_address;
  const addr = fromEnv ?? fromBundle ?? null;
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (addr as `0x${string}`) : null;
}

function rpcUrl(): string {
  return process.env.ACR_ARC_RPC_URL ?? bundleSection("chain")?.rpc_url ?? CHAIN.rpc;
}

let clientMemo: ReturnType<typeof createPublicClient> | null = null;
function client() {
  if (!clientMemo) {
    clientMemo = createPublicClient({
      // fetchOptions.cache is load-bearing: Next patches global fetch, and
      // WITHOUT it viem's RPC POSTs land in the Next Data Cache — the route
      // then serves frozen chain state (observed: prints days stale while the
      // chain was minutes fresh). `force-dynamic` does NOT cover library
      // fetches; only this opt-out does.
      transport: http(rpcUrl(), {
        timeout: 4_000,
        retryCount: 1,
        fetchOptions: { cache: "no-store" },
      }),
    });
  }
  return clientMemo;
}

/* 30s memo: prints move hourly in production — every visitor within the
   window shares one RPC round. Keyed on the history index so the heavier
   read doesn't serve where the light one was asked. A PARTIAL roster (the
   throttle ate some indices even after the retry pass) is memoized briefly,
   so the next poll can complete the set instead of pinning the gap. */
let memo: { at: number; historyFor: string | null; data: OnchainDirectRead } | null = null;
const MEMO_MS = 30_000;
const PARTIAL_MEMO_MS = 8_000;

/** Read the latest prints for every index; optionally the last 12 history
 *  rows for ONE index (`historyFor`) — a full-roster history read would blow
 *  a serverless timeout at the paced RPC rate. */
export async function readOracleDirect(
  historyFor: string | null = null,
): Promise<OnchainDirectRead | null> {
  const oracle = oracleAddress();
  if (!oracle) return null;
  if (memo && (memo.historyFor === historyFor || historyFor == null)) {
    const full = Object.keys(memo.data.prints).length === INDICES.length;
    if (Date.now() - memo.at < (full ? MEMO_MS : PARTIAL_MEMO_MS)) return memo.data;
  }

  const prints: OnchainDirectRead["prints"] = {};
  const readLatest = async (id: string): Promise<boolean> => {
    try {
      const [raw, age] = (await client().readContract({
        address: oracle,
        abi: ORACLE_ABI,
        functionName: "latestPrintWithAge",
        args: [indexIdBytes32(id)],
      })) as unknown as [RawPrint, bigint];
      const p = decodePrint(id, raw, age);
      if (p) prints[id] = p;
      return true; // resolved (even a non-existent print) — don't retry
    } catch {
      return false; // revert or throttled — candidate for the retry pass
    }
  };

  for (const id of INDICES) {
    await readLatest(id);
    await sleep(RPC_GAP_MS);
  }
  // Second pass for whatever the throttle ate — shared-egress hosts (Vercel)
  // get squeezed harder than a laptop, so back off further and try once more.
  const missed = INDICES.filter((id) => !(id in prints));
  if (missed.length > 0 && missed.length < INDICES.length) {
    await sleep(RPC_GAP_MS * 2);
    for (const id of missed) {
      await readLatest(id);
      await sleep(RPC_GAP_MS * 2);
    }
  }
  if (Object.keys(prints).length === 0) return null;

  const data: OnchainDirectRead = { prints };

  if (historyFor && prints[historyFor]) {
    const history: Record<string, HistoryPoint[]> = {};
    for (const id of [historyFor]) {
      try {
        const key = indexIdBytes32(id);
        const len = (await client().readContract({
          address: oracle,
          abi: ORACLE_ABI,
          functionName: "historyLength",
          args: [key],
        })) as bigint;
        await sleep(RPC_GAP_MS);
        const n = Number(len);
        const from = Math.max(0, n - HISTORY_POINTS);
        const points: HistoryPoint[] = [];
        for (let j = from; j < n; j++) {
          try {
            const raw = (await client().readContract({
              address: oracle,
              abi: ORACLE_ABI,
              functionName: "historyAt",
              args: [key, BigInt(j)],
            })) as unknown as RawPrint;
            const p = decodePrint(id, raw, 0n);
            if (p) points.push({ ts: p.timestamp, value: p.value, ci_lo: p.ci_lo, ci_hi: p.ci_hi });
          } catch {
            /* skip the throttled row */
          }
          await sleep(RPC_GAP_MS);
        }
        if (points.length) history[id] = points;
      } catch {
        /* history is best-effort */
      }
    }
    if (Object.keys(history).length) data.history = history;
  }

  memo = { at: Date.now(), historyFor, data };
  return data;
}
