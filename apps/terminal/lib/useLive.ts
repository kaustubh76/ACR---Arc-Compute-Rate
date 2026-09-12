"use client";

/* Client data layer: SWR over the Next proxy routes. All components share the
   same keys, so N hooks dedupe to one request per interval.

   Failure literacy: every hook carries the shared retry policy (bounded
   exponential backoff) and the ones whose empty state could lie ("no webhook
   events yet" when the press is actually down) expose `error` so callers can
   say "press unreachable" instead. */

import useSWR from "swr";

import type { GateData } from "./gate";
import type { HumanIdData } from "./humans";
import type { TapeData } from "./tape";
import type {
  AttackStatus,
  BalancesData,
  BuyerRunStatus,
  CatalogData,
  Envelope,
  FuturesRoster,
  HealthData,
  HedgerState,
  LiveBuyResponse,
  MarketReceiptsData,
  OnchainDirectRead,
  OpsLedger,
  RevenueData,
  TerminalData,
  WebhookFeed,
  X402Info,
} from "./types";

export class FetchError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new FetchError(`${res.status} ${url}`, res.status);
  return res.json();
};

/* Shared resilience policy: retry transient failures with capped exponential
   backoff, keep showing the last good data while retrying. The steady
   refreshInterval keeps probing after retries are spent, so recovery is
   automatic without a reload. */
const RETRY = {
  keepPreviousData: true,
  errorRetryCount: 6,
  onErrorRetry: (
    _err: unknown,
    _key: string,
    _config: unknown,
    revalidate: (opts: { retryCount: number }) => void,
    { retryCount }: { retryCount: number },
  ) => {
    if (retryCount >= 6) return;
    const delay = Math.min(30_000, 2_000 * 2 ** retryCount);
    setTimeout(() => revalidate({ retryCount }), delay);
  },
} as const;

export function useTerminal(initial?: Envelope<TerminalData>): Envelope<TerminalData> {
  const { data } = useSWR<Envelope<TerminalData>>("/api/terminal", fetcher, {
    refreshInterval: 15_000,
    fallbackData: initial,
    ...RETRY,
  });
  return (data ?? initial) as Envelope<TerminalData>;
}

export function useRevenue(initial?: Envelope<RevenueData>) {
  const { data, mutate } = useSWR<Envelope<RevenueData>>("/api/revenue", fetcher, {
    refreshInterval: 10_000,
    fallbackData: initial,
    ...RETRY,
  });
  return { revenue: data ?? initial, refresh: mutate };
}

/** Inbound Circle webhook events — the activity panel on Developers. Polls
 *  briskly so a Circle "Send test" ping shows up promptly. `error` set means
 *  the proxy itself is unreachable (distinct from a live-and-empty feed). */
export function useWebhooks() {
  const { data, error } = useSWR<Envelope<WebhookFeed>>("/api/webhooks", fetcher, {
    refreshInterval: 8_000,
    ...RETRY,
  });
  return { feed: data, error: error as Error | undefined };
}

/** The x402 gate descriptor — labels the console + gates the demo agent. */
export function useX402Info() {
  const { data } = useSWR<Envelope<X402Info | null>>("/api/console", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    ...RETRY,
  });
  return data;
}

/** The marketplace listings — the catalog changes rarely (price/config). */
export function useCatalog() {
  const { data } = useSWR<Envelope<CatalogData | null>>("/api/marketplace/catalog", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    ...RETRY,
  });
  return data;
}

/** The settlement tape — every paid query prints here, so poll like a ticker. */
export function useMarketReceipts() {
  const { data, error } = useSWR<Envelope<MarketReceiptsData | null>>(
    "/api/marketplace/receipts",
    fetcher,
    { refreshInterval: 5_000, ...RETRY },
  );
  return { tape: data, error: error as Error | undefined };
}

/** The live futures venue — desks + the on-chain trade tape. Polls fast (~4s)
 *  while the press serves (its caches keep RPC off the path); backs off to
 *  30s on the direct-chain tier (each refresh is a paced RPC crawl behind a
 *  60s server memo) and 15s on the archived bundle. Decoupled from
 *  /terminal/data so the desk stays lively without waiting on the heavy feed. */
/** The autonomous hedger's standing. Polls slower than the desk: this agent
 *  acts on a mandate, not on every tick, so a 4s refresh would spend requests
 *  watching a number that changes a few times an hour. */
export function useHedger() {
  const { data, error } = useSWR<Envelope<HedgerState>>("/api/hedger", fetcher, {
    refreshInterval: (latest) => (latest?.live ? 15_000 : 60_000),
    ...RETRY,
  });
  return { hedger: data, error: error as Error | undefined };
}

export function useFutures() {
  const { data, error } = useSWR<Envelope<FuturesRoster>>("/api/futures", fetcher, {
    refreshInterval: (latest) =>
      latest?.data?.source === "chain" ? 30_000 : latest?.live ? 4_000 : 15_000,
    ...RETRY,
  });
  return { roster: data, error: error as Error | undefined };
}

/** The mode oracle: gate + chain + poster status. Drives the StatusPill and
 *  live checklists; null data offline (the pill degrades honestly). */
export function useHealth() {
  const { data } = useSWR<Envelope<HealthData | null>>("/api/health", fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
    ...RETRY,
  });
  return data;
}

/** Who the benchmark is secured by, and what "verified" means here.
 *
 *  Polled far slower than the tape on purpose: the count turns over once per
 *  7-day rotation window and the Sandbox flag is configuration, so a 15s poll
 *  would be load spent re-reading a number that cannot have moved.
 *
 *  Returns the whole envelope rather than the data, because consumers need
 *  `live` to tell "the press is down" from "nobody is verified" — the one
 *  distinction this feature is required to keep. */
/** What guards agent-to-agent traffic, read from the service itself.
 *
 *  Polled slowly on purpose: the audience, the tiers and which backend answered
 *  are configuration, and the counters are evidence rather than a live market
 *  reading. A 15s poll here would be load spent re-reading settings.
 *
 *  Returns the whole envelope because `live` carries the distinction that matters:
 *  "the press is down" and "there is no screen" must not render the same, which is
 *  the same rule `useHumanId` exists to keep. */
export function useGate() {
  const { data } = useSWR<Envelope<GateData>>("/api/gate", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    ...RETRY,
  });
  return data;
}

export function useHumanId() {
  const { data } = useSWR<Envelope<HumanIdData>>("/api/humanid", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    ...RETRY,
  });
  return data;
}

/** Direct viem reads against ACROracle via /api/onchain — the tier that keeps
 *  REAL prints on screen when the FastAPI press is cold. Pass `enabled: false`
 *  while the terminal feed is live (null key = zero extra load on the healthy
 *  path). */
export function useOnchainPrints(enabled: boolean) {
  const { data } = useSWR<Envelope<OnchainDirectRead | null>>(
    enabled ? "/api/onchain" : null,
    fetcher,
    { refreshInterval: 60_000, revalidateOnFocus: false, ...RETRY },
  );
  return data;
}

/** The heavier direct read: latest prints PLUS the last ~12 on-chain history
 *  rows for ONE index — feeds the index-detail chart when the press is down.
 *  Same discipline: null key while live. */
export function useOnchainHistory(indexId: string, enabled: boolean) {
  const { data } = useSWR<Envelope<OnchainDirectRead | null>>(
    enabled ? `/api/onchain?history=${encodeURIComponent(indexId)}` : null,
    fetcher,
    { refreshInterval: 120_000, revalidateOnFocus: false, ...RETRY },
  );
  return data;
}

/** The floor buyer's run — polls fast only while queries are being bought,
 * so the tape and counters tick in near-real-time during a run. */
export function useBuyerRun() {
  const { data, mutate } = useSWR<Envelope<BuyerRunStatus | null>>("/api/demo/buyer", fetcher, {
    refreshInterval: (latest) => (latest?.data?.state === "running" ? 700 : 0),
    revalidateOnFocus: true,
    ...RETRY,
  });
  return { status: data, refresh: mutate };
}

/** Readiness of the REAL Circle buyer: is a funded key present AND the seller
 *  on the Circle gate? Drives whether the "LIVE buyer" control appears. */
export function useBuyerReady() {
  const { data } = useSWR<LiveBuyResponse>("/api/buy", fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
    ...RETRY,
  });
  return data;
}

/** Live Circle wallet balances (seller + buyer + Gateway deposit). Polls
 *  steadily; the exchange calls `refresh` right after a live settlement so the
 *  deposit is seen ticking down. */
export function useBalances() {
  const { data, error, mutate } = useSWR<Envelope<BalancesData>>("/api/circle/balances", fetcher, {
    refreshInterval: 12_000,
    ...RETRY,
  });
  return { balances: data, error: error as Error | undefined, refresh: mutate };
}

/** Fast while a run is in flight; a slow heartbeat otherwise.
 *
 *  The idle interval used to be `0`, which SWR reads as "never poll again" —
 *  so after one request on mount the Attack Lab went permanently silent. Every
 *  live thing on that page (the press chip, the last-run age, the resting
 *  counters) is downstream of this number; at 0 none of them could ever
 *  update, which is precisely why the page read as a static picture. 20s is
 *  the `useHedger` cadence: enough to prove the page is connected, cheap
 *  enough for a free-tier press. */
export function useAttackRun() {
  const { data, mutate } = useSWR<Envelope<AttackStatus>>("/api/attack/status", fetcher, {
    refreshInterval: (latest) => (latest?.data?.state === "running" ? 700 : 20_000),
    revalidateOnFocus: true,
    ...RETRY,
  });
  return { status: data, refresh: mutate };
}

/** The systems ledger (/ops). Recomputes upstream every 15 minutes, so this
 *  polls slowly — and carries no bundle tier by design: a stale VERDICT would
 *  assert the health of a press that is, right then, not answering. */
/** The indexed tape: what an agent paid against what it could have seen.
 *
 * 30s, not the 15s of the press feed: the tape moves when a settlement is
 * mirrored, which is minutes apart at best, and each poll costs the subgraph
 * several queries. Never 0 — SWR reads 0 as "never poll again", which once left
 * a whole page silently static (see useAttackRun below).
 *
 * `error` is exposed because this hook's empty state can lie: a page rendering
 * "no settlements" when the subgraph is unreachable would report an outage as a
 * quiet market, which is the failure the tape exists to make impossible. */
export function useTape(payer?: string) {
  const key = payer ? `/api/tape?payer=${payer}` : "/api/tape";
  const { data, error, mutate } = useSWR<Envelope<TapeData>>(key, fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    ...RETRY,
  });
  return { tape: data, error: error as Error | undefined, refresh: mutate };
}

export function useOps() {
  const { data, error, mutate } = useSWR<Envelope<OpsLedger | null>>("/api/ops", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
    ...RETRY,
  });
  return { ledger: data, error: error as Error | undefined, refresh: mutate };
}
