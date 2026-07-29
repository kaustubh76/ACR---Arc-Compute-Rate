"use client";

/* Client data layer: SWR over the Next proxy routes. All components share the
   same keys, so N hooks dedupe to one request per interval.

   Failure literacy: every hook carries the shared retry policy (bounded
   exponential backoff) and the ones whose empty state could lie ("no webhook
   events yet" when the press is actually down) expose `error` so callers can
   say "press unreachable" instead. */

import useSWR from "swr";
import type {
  AttackStatus,
  BalancesData,
  BuyerRunStatus,
  CatalogData,
  Envelope,
  HealthData,
  LiveBuyResponse,
  MarketReceiptsData,
  OnchainDirectRead,
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

/** Polls fast only while a run is in flight; the chart is the progress bar. */
export function useAttackRun() {
  const { data, mutate } = useSWR<Envelope<AttackStatus>>("/api/attack/status", fetcher, {
    refreshInterval: (latest) => (latest?.data?.state === "running" ? 700 : 0),
    revalidateOnFocus: true,
    ...RETRY,
  });
  return { status: data, refresh: mutate };
}
