"use client";

/* Client data layer: SWR over the Next proxy routes. All components share the
   same keys, so N hooks dedupe to one request per interval. */

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
  RevenueData,
  TerminalData,
  WebhookFeed,
  X402Info,
} from "./types";

export const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

export function useTerminal(initial?: Envelope<TerminalData>): Envelope<TerminalData> {
  const { data } = useSWR<Envelope<TerminalData>>("/api/terminal", fetcher, {
    refreshInterval: 15_000,
    fallbackData: initial,
    keepPreviousData: true,
  });
  return (data ?? initial) as Envelope<TerminalData>;
}

export function useRevenue(initial?: Envelope<RevenueData>) {
  const { data, mutate } = useSWR<Envelope<RevenueData>>("/api/revenue", fetcher, {
    refreshInterval: 10_000,
    fallbackData: initial,
    keepPreviousData: true,
  });
  return { revenue: data ?? initial, refresh: mutate };
}

/** Inbound Circle webhook events — the activity panel on Developers. Polls
 *  briskly so a Circle "Send test" ping shows up promptly. */
export function useWebhooks() {
  const { data } = useSWR<Envelope<WebhookFeed>>("/api/webhooks", fetcher, {
    refreshInterval: 8_000,
    keepPreviousData: true,
  });
  return data;
}

/** The x402 gate descriptor — labels the console + gates the demo agent. */
export function useX402Info() {
  const { data } = useSWR<Envelope<X402Info | null>>("/api/console", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
  });
  return data;
}

/** The marketplace listings — the catalog changes rarely (price/config). */
export function useCatalog() {
  const { data } = useSWR<Envelope<CatalogData | null>>("/api/marketplace/catalog", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
  });
  return data;
}

/** The settlement tape — every paid query prints here, so poll like a ticker. */
export function useMarketReceipts() {
  const { data } = useSWR<Envelope<MarketReceiptsData | null>>(
    "/api/marketplace/receipts",
    fetcher,
    { refreshInterval: 5_000, keepPreviousData: true },
  );
  return data;
}

/** The mode oracle: gate + chain + poster status. Drives the StatusPill and
 *  live checklists; null data offline (the pill degrades to SIM). */
export function useHealth() {
  const { data } = useSWR<Envelope<HealthData | null>>("/api/health", fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
  });
  return data;
}

/** The floor buyer's run — polls fast only while queries are being bought,
 * so the tape and counters tick in near-real-time during a run. */
export function useBuyerRun() {
  const { data, mutate } = useSWR<Envelope<BuyerRunStatus | null>>("/api/demo/buyer", fetcher, {
    refreshInterval: (latest) => (latest?.data?.state === "running" ? 700 : 0),
    revalidateOnFocus: true,
  });
  return { status: data, refresh: mutate };
}

/** Readiness of the REAL Circle buyer: is a funded key present AND the seller
 *  on the Circle gate? Drives whether the "LIVE buyer" control appears. */
export function useBuyerReady() {
  const { data } = useSWR<LiveBuyResponse>("/api/buy", fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
  });
  return data;
}

/** Live Circle wallet balances (seller + buyer + Gateway deposit). Polls
 *  steadily; the exchange calls `refresh` right after a live settlement so the
 *  deposit is seen ticking down. */
export function useBalances() {
  const { data, mutate } = useSWR<Envelope<BalancesData>>("/api/circle/balances", fetcher, {
    refreshInterval: 12_000,
    keepPreviousData: true,
  });
  return { balances: data, refresh: mutate };
}

/** Polls fast only while a run is in flight; the chart is the progress bar. */
export function useAttackRun() {
  const { data, mutate } = useSWR<Envelope<AttackStatus>>("/api/attack/status", fetcher, {
    refreshInterval: (latest) => (latest?.data?.state === "running" ? 700 : 0),
    revalidateOnFocus: true,
  });
  return { status: data, refresh: mutate };
}
