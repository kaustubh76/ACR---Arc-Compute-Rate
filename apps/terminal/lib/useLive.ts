"use client";

/* Client data layer: SWR over the Next proxy routes. All components share the
   same keys, so N hooks dedupe to one request per interval.

   Failure literacy: every hook carries the shared retry policy (bounded
   exponential backoff) and the ones whose empty state could lie ("no webhook
   events yet" when the press is actually down) expose `error` so callers can
   say "press unreachable" instead. */

import useSWR from "swr";
import { apiKey, sameChain, type ChainKey } from "./chainChoice";
import { cardHeaders, readerCardNow, useReaderCard } from "./readerCard";
import { useChain } from "./useChain";

import type { Refusal } from "./api";
import type { GateData } from "./gate";
import type { ClustersData, HumanIdData } from "./humans";
import type { TapeData } from "./tape";
import type {
  AttackStatus,
  BalancesData,
  BusinessesPayload,
  BuyerRunStatus,
  CatalogData,
  Envelope,
  FuturesRoster,
  HealthData,
  HedgerState,
  LedgerAudit,
  LiveBuyResponse,
  MarketReceiptsData,
  OnchainDirectRead,
  OpsLedger,
  ParCheck,
  RevenueData,
  Statement,
  TerminalData,
  TractionPayload,
  WebhookFeed,
  X402Info,
} from "./types";

export class FetchError extends Error {
  status: number;
  /** The press's own refusal, when the proxy passed one through — the 401
   *  challenge object or a 403's sentence. Undefined for every other failure,
   *  which is how a caller tells "you may not read this" from "this is down". */
  refusal?: Refusal;
  /** What the proxy said about the host: `"absent"` when the press answered
   *  404 and its own spec does not list the route, i.e. a deployment that
   *  predates the feature rather than a service that is down. Carried so a
   *  view can say which, because "it is not running" sends a reader away from
   *  the network where it is. */
  upstream?: Envelope<unknown>["upstream"];
  constructor(message: string, status: number, refusal?: Refusal, upstream?: Envelope<unknown>["upstream"]) {
    super(message);
    this.status = status;
    if (refusal) this.refusal = refusal;
    if (upstream) this.upstream = upstream;
  }
}

/** Whether a status is this reader being refused rather than something failing.
 *
 *  USED TO STOP RETRYING. `RETRY` below backs off six times over about two
 *  minutes, which is right for a cold press and wrong for a credential: a card
 *  the press has refused will be refused identically six more times, and the
 *  reader watches a spinner instead of reading the sentence that tells them what
 *  to claim. Mirrors `isRefusal` in lib/api.ts, same two statuses. */
export function isRefusal(status: number): boolean {
  return status === 401 || status === 403;
}

export const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    /* THE REFUSAL HAS TO SURVIVE THE THROW. `fetcher` dropped the body on every
       error, which was invisible while no upstream could refuse a read; now the
       press answers four different sentences and the one the reader needs is in
       there. Parsed defensively: a 502 from an edge is HTML, and an unparseable
       body must still throw the status rather than throw a parse error. */
    /* Both the refusal and the upstream verdict are read from the one body.
       `upstream` is what tells a view "this press predates the route" from
       "this press is down", and the proxies have always stamped it — nothing
       read it, so every failure read as an outage. */
    let refusal: Refusal | undefined;
    let upstream: Envelope<unknown>["upstream"];
    try {
      const body = (await res.json()) as {
        refusal?: Refusal;
        detail?: unknown;
        upstream?: Envelope<unknown>["upstream"];
      };
      upstream = body?.upstream;
      if (isRefusal(res.status)) {
        refusal = body?.refusal ?? { status: res.status, detail: body?.detail ?? null };
      }
    } catch {
      if (isRefusal(res.status)) refusal = { status: res.status, detail: null };
    }
    throw new FetchError(`${res.status} ${url}`, res.status, refusal, upstream);
  }
  return res.json();
};

/** `fetcherFor`, plus this tab's card on the wire.
 *
 *  Only the per-business reads use it. `/operator/businesses` and
 *  `/operator/traction` are counts, they stay public in both flag states, and
 *  sending a credential to fetch a public aggregate would be a credential sent
 *  for no reason.
 *
 *  THE CARD IS NOT IN THE KEY. It is read here, at fetch time, from the tab's
 *  store — so SWR's cache key stays the URL and a bearer token never reaches a
 *  URL, an access log or a CDN cache key. `setReaderCard` is what revalidates
 *  when it changes; the trade and the one property it depends on ("one card per
 *  tab") are written out in lib/readerCard.ts. */
export const cardFetcherFor = (chain: ChainKey) => async (url: string) => {
  const card = readerCardNow();
  const res = await fetch(url, { headers: cardHeaders(card) });
  if (!res.ok) {
    /* Both the refusal and the upstream verdict are read from the one body.
       `upstream` is what tells a view "this press predates the route" from
       "this press is down", and the proxies have always stamped it — nothing
       read it, so every failure read as an outage. */
    let refusal: Refusal | undefined;
    let upstream: Envelope<unknown>["upstream"];
    try {
      const body = (await res.json()) as {
        refusal?: Refusal;
        detail?: unknown;
        upstream?: Envelope<unknown>["upstream"];
      };
      upstream = body?.upstream;
      if (isRefusal(res.status)) {
        refusal = body?.refusal ?? { status: res.status, detail: body?.detail ?? null };
      }
    } catch {
      if (isRefusal(res.status)) refusal = { status: res.status, detail: null };
    }
    throw new FetchError(`${res.status} ${url}`, res.status, refusal, upstream);
  }
  const body = await res.json();
  if (!sameChain(body, chain)) {
    const got = String((body as { chain?: unknown } | null)?.chain);
    throw new FetchError(`chain mismatch on ${url}: asked ${chain}, got ${got}`, 409);
  }
  return body;
};

/** A fetcher that refuses an answer from the wrong chain.
 *
 *  THE GUARD THAT HOLDS WHEN PREVENTION FAILS. The chain is in the cookie (for
 *  the server render) and in the URL (so a shared cache keys on it), and either
 *  can be defeated by a layer nobody predicted — sixteen of these routes answer
 *  with `Cache-Control: public, s-maxage=…`, and Vercel's CDN keys on URL alone.
 *  So every envelope carries the chain that produced it, and this compares it
 *  against the chain that was asked for. The 409 travels through the existing
 *  RETRY policy, so a surface shows its own error state rather than another
 *  chain's numbers — which matters doubly because that policy sets
 *  `keepPreviousData: true`.
 *
 *  A MISSING stamp is a mismatch, not a default: "I do not know which chain this
 *  is" must never render as mainnet. */
export const fetcherFor = (chain: ChainKey) => async (url: string) => {
  const body = await fetcher(url);
  if (!sameChain(body, chain)) {
    const got = String((body as { chain?: unknown } | null)?.chain);
    throw new FetchError(`chain mismatch on ${url}: asked ${chain}, got ${got}`, 409);
  }
  return body;
};

/* Shared resilience policy: retry transient failures with capped exponential
   backoff, keep showing the last good data while retrying. The steady
   refreshInterval keeps probing after retries are spent, so recovery is
   automatic without a reload. */
const RETRY = {
  keepPreviousData: true,
  errorRetryCount: 6,
  onErrorRetry: (
    err: unknown,
    _key: string,
    _config: unknown,
    revalidate: (opts: { retryCount: number }) => void,
    { retryCount }: { retryCount: number },
  ) => {
    // A refused credential is not a transient failure. Retrying it six times
    // shows a spinner where the page should be showing the press's own sentence
    // about what to claim, and asks the press to re-verify a signature it has
    // already rejected. `setReaderCard` revalidates when the card changes,
    // which is the only event that could change this answer.
    if (err instanceof FetchError && isRefusal(err.status)) return;
    /* Nor is a route this deployment does not have. Retrying it six times over
       about two minutes leaves the submit button on /check flickering between
       "Pricing…" and "Price this bill" while the answer sits below it, and the
       press is not going to grow the route while the reader waits. */
    if (err instanceof FetchError && err.upstream === "absent") return;
    if (retryCount >= 6) return;
    const delay = Math.min(30_000, 2_000 * 2 ** retryCount);
    setTimeout(() => revalidate({ retryCount }), delay);
  },
} as const;

export function useTerminal(initial?: Envelope<TerminalData>): Envelope<TerminalData> {
  const chain = useChain();
  const { data } = useSWR<Envelope<TerminalData>>(apiKey("/api/terminal", chain), fetcherFor(chain), {
    refreshInterval: 15_000,
    fallbackData: initial,
    ...RETRY,
  });
  return (data ?? initial) as Envelope<TerminalData>;
}

export function useRevenue(initial?: Envelope<RevenueData>) {
  const chain = useChain();
  const { data, mutate } = useSWR<Envelope<RevenueData>>(apiKey("/api/revenue", chain), fetcherFor(chain), {
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
  const chain = useChain();
  const { data, error } = useSWR<Envelope<WebhookFeed>>(apiKey("/api/webhooks", chain), fetcherFor(chain), {
    refreshInterval: 8_000,
    ...RETRY,
  });
  return { feed: data, error: error as Error | undefined };
}

/** The x402 gate descriptor — labels the console + gates the demo agent. */
export function useX402Info() {
  const chain = useChain();
  const { data } = useSWR<Envelope<X402Info | null>>(apiKey("/api/console", chain), fetcherFor(chain), {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    ...RETRY,
  });
  return data;
}

/** The marketplace listings — the catalog changes rarely (price/config). */
export function useCatalog() {
  const chain = useChain();
  const { data } = useSWR<Envelope<CatalogData | null>>(apiKey("/api/marketplace/catalog", chain), fetcherFor(chain), {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    ...RETRY,
  });
  return data;
}

/** The settlement tape — every paid query prints here, so poll like a ticker. */
export function useMarketReceipts() {
  const chain = useChain();
  const { data, error } = useSWR<Envelope<MarketReceiptsData | null>>(
    apiKey("/api/marketplace/receipts", chain),
    fetcherFor(chain),
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
  const chain = useChain();
  const { data, error } = useSWR<Envelope<HedgerState>>(apiKey("/api/hedger", chain), fetcherFor(chain), {
    refreshInterval: (latest) => (latest?.live ? 15_000 : 60_000),
    ...RETRY,
  });
  return { hedger: data, error: error as Error | undefined };
}

export function useFutures() {
  const chain = useChain();
  const { data, error } = useSWR<Envelope<FuturesRoster>>(apiKey("/api/futures", chain), fetcherFor(chain), {
    refreshInterval: (latest) =>
      latest?.data?.source === "chain" ? 30_000 : latest?.live ? 4_000 : 15_000,
    ...RETRY,
  });
  return { roster: data, error: error as Error | undefined };
}

/** The mode oracle: gate + chain + poster status. Drives the StatusPill and
 *  live checklists; null data offline (the pill degrades honestly). */
export function useHealth() {
  const chain = useChain();
  const { data } = useSWR<Envelope<HealthData | null>>(apiKey("/api/health", chain), fetcherFor(chain), {
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
  const chain = useChain();
  const { data } = useSWR<Envelope<GateData>>(apiKey("/api/gate", chain), fetcherFor(chain), {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    ...RETRY,
  });
  return data;
}

/** The same envelope with a refresh handle, for a surface that just CHANGED the
 *  counters it renders (the screen lab) and should not wait a minute to show it. */
export function useGateLive() {
  const chain = useChain();
  const { data, mutate } = useSWR<Envelope<GateData>>(apiKey("/api/gate", chain), fetcherFor(chain), {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    ...RETRY,
  });
  return { gate: data, refresh: mutate };
}

export function useClusters() {
  const chain = useChain();
  const { data } = useSWR<Envelope<ClustersData | null>>(apiKey("/api/humanid/clusters", chain), fetcherFor(chain), {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    ...RETRY,
  });
  return data;
}

export function useHumanId() {
  const chain = useChain();
  const { data } = useSWR<Envelope<HumanIdData>>(apiKey("/api/humanid", chain), fetcherFor(chain), {
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
  const chain = useChain();
  const { data } = useSWR<Envelope<OnchainDirectRead | null>>(
    enabled ? apiKey("/api/onchain", chain) : null,
    fetcherFor(chain),
    { refreshInterval: 60_000, revalidateOnFocus: false, ...RETRY },
  );
  return data;
}

/** The heavier direct read: latest prints PLUS the last ~12 on-chain history
 *  rows for ONE index — feeds the index-detail chart when the press is down.
 *  Same discipline: null key while live. */
export function useOnchainHistory(indexId: string, enabled: boolean) {
  const chain = useChain();
  const { data } = useSWR<Envelope<OnchainDirectRead | null>>(
    enabled ? apiKey(`/api/onchain?history=${encodeURIComponent(indexId)}`, chain) : null,
    fetcherFor(chain),
    { refreshInterval: 120_000, revalidateOnFocus: false, ...RETRY },
  );
  return data;
}

/** The floor buyer's run — polls fast only while queries are being bought,
 * so the tape and counters tick in near-real-time during a run. */
export function useBuyerRun() {
  const chain = useChain();
  const { data, mutate } = useSWR<Envelope<BuyerRunStatus | null>>(apiKey("/api/demo/buyer", chain), fetcherFor(chain), {
    refreshInterval: (latest) => (latest?.data?.state === "running" ? 700 : 0),
    revalidateOnFocus: true,
    ...RETRY,
  });
  return { status: data, refresh: mutate };
}

/** Readiness of the REAL Circle buyer: is a funded key present AND the seller
 *  on the Circle gate? Drives whether the "LIVE buyer" control appears. */
export function useBuyerReady() {
  const chain = useChain();
  const { data } = useSWR<LiveBuyResponse>(apiKey("/api/buy", chain), fetcherFor(chain), {
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
  const chain = useChain();
  const { data, error, mutate } = useSWR<Envelope<BalancesData>>(apiKey("/api/circle/balances", chain), fetcherFor(chain), {
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
  const chain = useChain();
  const { data, mutate } = useSWR<Envelope<AttackStatus>>(apiKey("/api/attack/status", chain), fetcherFor(chain), {
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
  const chain = useChain();
  const key = apiKey(payer ? `/api/tape?payer=${payer}` : "/api/tape", chain);
  const { data, error, mutate } = useSWR<Envelope<TapeData>>(key, fetcherFor(chain), {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    ...RETRY,
  });
  return { tape: data, error: error as Error | undefined, refresh: mutate };
}

export function useOps() {
  const chain = useChain();
  const { data, error, mutate } = useSWR<Envelope<OpsLedger | null>>(apiKey("/api/ops", chain), fetcherFor(chain), {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
    ...RETRY,
  });
  return { ledger: data, error: error as Error | undefined, refresh: mutate };
}

/** Who the operator runs for. Slow-moving (onboarding is a commit), so this
 *  polls gently — the page is not waiting on it to change. */
export function useBusinesses() {
  const chain = useChain();
  const { data, error, mutate } = useSWR<Envelope<BusinessesPayload | null>>(
    apiKey("/api/operator/businesses", chain),
    fetcherFor(chain),
    { refreshInterval: 300_000, revalidateOnFocus: true, ...RETRY },
  );
  return { businesses: data, error: error as FetchError | undefined, refresh: mutate };
}

/** One business's Spend Statement. `null` slug means "nothing selected yet",
 *  and SWR is given a null key so it does not fetch a statement for nobody. */
export function useStatement(slug: string | null, days = 7) {
  const chain = useChain();
  // Subscribed, not merely read: a pasted card must re-render this hook's
  // consumers, and `setReaderCard`'s revalidation only refetches — it does not
  // by itself tell React that the refusal on screen is now stale.
  useReaderCard();
  const { data, error, mutate } = useSWR<Envelope<Statement | null>>(
    slug ? apiKey(`/api/operator/statement?business=${encodeURIComponent(slug)}&days=${days}`, chain) : null,
    cardFetcherFor(chain),
    { refreshInterval: 30_000, revalidateOnFocus: true, ...RETRY },
  );
  return { statement: data, error: error as FetchError | undefined, refresh: mutate };
}

/** One bill, priced against published third-party prices — the /check page.
 *
 *  `query` is null until a visitor has actually submitted something, because a
 *  price check has no answer until somebody types one. Same null-key idiom as
 *  `useStatement`, used for the same reason and with two deliberate
 *  differences:
 *
 *  NO `refreshInterval`, NO `revalidateOnFocus`. Re-polling a price check is
 *  pointless at best: the basket behind it is a dated file refreshed by hand,
 *  so a second request cannot return a different answer, and a verdict that
 *  silently changed while a reader was looking away would be worse than one
 *  that did not. The reader's own submit is the only thing that should refetch.
 *
 *  `keepPreviousData` comes from RETRY and is kept on purpose: while a new
 *  check is in flight the previous verdict stays on screen rather than
 *  flashing empty, which is what `readResult.keepLast` exists to say. */
export function useParCheck(query: string | null) {
  const chain = useChain();
  const { data, error, isLoading, mutate } = useSWR<Envelope<ParCheck | null>>(
    query ? apiKey(`/api/par?${query}`, chain) : null,
    fetcherFor(chain),
    { ...RETRY, refreshInterval: 0, revalidateOnFocus: false },
  );
  return {
    check: data,
    error: error as FetchError | undefined,
    loading: isLoading,
    refresh: mutate,
  };
}

/** One business's ledger audit. Polls beside the statement it sits with,
 *  because both answer the same question: is this book telling the truth now. */
export function useLedgerAudit(slug: string | null, days = 90) {
  const chain = useChain();
  useReaderCard();
  const { data, error, mutate } = useSWR<Envelope<LedgerAudit | null>>(
    slug ? apiKey(`/api/operator/audit?business=${encodeURIComponent(slug)}&days=${days}`, chain) : null,
    cardFetcherFor(chain),
    { refreshInterval: 60_000, revalidateOnFocus: true, ...RETRY },
  );
  return { ledgerAudit: data, error: error as FetchError | undefined, refresh: mutate };
}

/** The traction numbers. Slow-moving and cheap to recompute, so this polls
 *  gently — nobody is watching it tick. */
export function useTraction() {
  const chain = useChain();
  const { data, error, mutate } = useSWR<Envelope<TractionPayload | null>>(
    apiKey("/api/operator/traction", chain),
    fetcherFor(chain),
    { refreshInterval: 120_000, revalidateOnFocus: true, ...RETRY },
  );
  return { traction: data, error: error as FetchError | undefined, refresh: mutate };
}
