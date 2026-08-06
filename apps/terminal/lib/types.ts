export interface CurvePoint {
  tenor_weeks: number;
  expiry_ts: number;
  mid: number;
  bid: number;
  ask: number;
  spread_bp: number;
}

export interface OnchainPrint {
  index_id: string;
  value: number;
  ci_lo: number;
  ci_hi: number;
  attack_cost_per_bp: number;
  timestamp: number;
  posted_at?: number;
}

export interface Robustness {
  single_cluster_flip_fraction: number;
  max_cluster_share: number;
  max_cluster_influence_bp: number;
  sybil_clusters_required: number;
  min_identities: number;
}

export interface PrintRow {
  index_id: string;
  ts: number;
  value: number;
  ci_lo: number;
  ci_hi: number;
  attack_cost_per_bp: number;
  n_obs: number;
  trim_alpha?: number;
  unit: string;
  naive_vwap: number;
  cost_to_move_1pct: number;
  cleaned_pct: number;
  vol: number;
  curve: CurvePoint[];
  robustness?: Robustness | null;
  onchain?: OnchainPrint | null;
}

export interface HistoryPoint {
  ts: number;
  value: number;
  ci_lo: number;
  ci_hi: number;
}

export interface SellerRow {
  seller: string;
  score: number;
  clean_share: number;
  attested: boolean;
  volume_usdc: number;
}

export interface AttackIndexRow {
  index_id: string;
  true: number;
  acr_clean: number;
  acr_attacked: number;
  vwap_clean: number;
  vwap_attacked: number;
  vwap_swing_pct: number;
  acr_swing_pct: number;
}

export interface SeriesPoint {
  hour: number;
  true: number;
  acr: number;
  vwap: number;
  acr_err_bp: number;
  vwap_err_bp: number;
  attack: boolean;
}

/** One oracle post's provenance: the postPrint tx + block, per index. */
export interface PosterRef {
  tx: string | null;
  block: number | null;
  at_wall: number | null;
  note?: string;
}

/** The chain facts block emitted by build_terminal_payload — the single
 *  source the UI uses to render network identity, explorer links, and
 *  publishing provenance. */
export interface ChainFactsData {
  name: string;
  chain_id: number;
  caip2: string;
  rpc_url: string;
  explorer_base: string;
  usdc_address: string;
  gateway_wallet: string;
  oracle_address: string | null;
  registry_address: string | null;
  futures_address: string | null;
  /** FeedAccessAttestor — null until deployed/configured, so the chip stays
   *  off rather than rendering a zero address. */
  attestor_address?: string | null;
  gate: "dev" | "circle";
  tape_source: string;
  signer: string | null;
  poster: { posts: number; last: Record<string, PosterRef> } | null;
}

/** A recorded two-act x402 exchange bundled into the snapshot so the
 *  developer console has honest content offline. */
export interface ExchangeSample {
  challenge: { status: number; headers: Record<string, string>; body: unknown };
  settled: {
    status: number;
    payer: string;
    headers: Record<string, string>;
    body_note?: string;
  };
}

/** The live on-chain futures desk for one index, read from ACRFutures — the
 *  maker's book (inventory + mark-to-oracle PnL) and settlement status. Emitted
 *  per index under TerminalData.futures; empty {} when no venue is configured. */
export interface FuturesDeskRow {
  series_id: number;
  index_id: string;
  expiry_ts: number;
  multiplier: number;
  maker: string;
  settled: boolean;
  settlement_price: number;
  maker_inventory: number;
  maker_avg_price: number;
  maker_realized_usdc: number;
  maker_unrealized_usdc: number;
  open_interest: number;
  trader_count: number;
}

/** One real on-chain futures fill (an ACRFutures `Traded` event), for the tape. */
export interface FuturesTradeRow {
  series_id: number;
  taker: string;
  qty: number; // signed contracts (+buy / −sell)
  side: "buy" | "sell";
  mark: number;
  block: number;
  tx: string;
  seen_at: number; // server-first-seen wall-clock (epoch seconds)
}

/** The whole futures venue for the live desk + tape (GET /futures).
 *  `source` says which ladder tier served it: the FastAPI press, a direct
 *  viem read of ACRFutures, or the archived bundle. */
export interface FuturesRoster {
  venue: string | null;
  desks: Record<string, FuturesDeskRow>;
  trades: FuturesTradeRow[];
  source?: "press" | "chain" | "bundle";
}

/** The autonomous hedger's standing (GET /hedger).
 *  TWO addresses, one agent — see docs/WALLETS.md. `agent` is the Circle agent
 *  wallet's smart account, which `ACRFutures.trade` records as the taker;
 *  `payer` is its backing EOA, which the x402 settlement records because
 *  EIP-3009 needs a signature `ecrecover` can verify. Nulls mean "not read",
 *  never "zero" — an unread balance and an empty one call for opposite
 *  conclusions. */
export interface HedgerState {
  configured: boolean;
  agent: string | null;
  payer: string | null;
  index_id: string;
  target_contracts: number;
  venue: string | null;
  wallet_kind: string;
  series_id: number | null;
  position_contracts: number | null;
  gap_contracts: number | null;
  collateral_usdc: number | null;
  paid_queries: number | null;
  spent_usdc: number | null;
  fills: FuturesTradeRow[];
}

export interface TerminalData {
  prints: Record<string, PrintRow>;
  history?: Record<string, HistoryPoint[]>;
  sellers?: Record<string, SellerRow[]>;
  /** On-chain futures desks per index (absent/empty when no venue configured). */
  futures?: Record<string, FuturesDeskRow>;
  attack: {
    per_index: AttackIndexRow[];
    series: SeriesPoint[];
    usdc_burned: number;
    n_adversarial: number;
  };
  oracle?: string | null;
  chain?: ChainFactsData | null;
  /* bundle-only sections (snapshot enrichment — absent from live /terminal/data) */
  /** Real on-chain fills captured at snapshot time — the archived tape. */
  futures_trades?: FuturesTradeRow[];
  /** The autonomous hedger's standing at snapshot time. */
  hedger?: HedgerState | null;
  marketplace?: { catalog: CatalogData | null; receipts: MarketReceiptsData | null } | null;
  revenue?: RevenueData | null;
  x402?: X402Info | null;
  x402_exchange_sample?: ExchangeSample | null;
}

/** Every proxy response is wrapped: `live` is false when serving the bundled
 *  snapshot (the "archived edition"). `upstream` (optional, newer proxies)
 *  says WHY a response is not live — "error"/"timeout" mean the press is
 *  unreachable, which the UI renders differently from a genuine empty. */
export interface Envelope<T> {
  live: boolean;
  data: T;
  fetchedAt: number;
  upstream?: "ok" | "error" | "timeout";
}

/** Payload of /api/onchain — settlement-grade prints read straight from
 *  ACROracle with viem, independent of the FastAPI press. */
export interface OnchainDirectRead {
  prints: Record<string, OnchainPrint & { age_s: number }>;
  history?: Record<string, HistoryPoint[]>;
  /** True when the crawl resolved SOME indices but not all. A partial read must
   *  not light the page-level "reading direct from the chain" rung: the rows it
   *  missed are still archived, and one boolean claimed fresh provenance for
   *  all of them. */
  partial?: boolean;
}

export type AttackRunState = "idle" | "running" | "done" | "error";

export interface AttackVerdict {
  vwap_swing_pct: number;
  acr_swing_pct: number;
  resistance: number;
  peak_vwap_err_bp: number;
  peak_acr_err_bp: number;
}

export interface AttackStatus {
  state: AttackRunState;
  params: { budget_usdc: number; target_multiplier: number; seed: number } | null;
  hour: number;
  hours_total: number;
  series: SeriesPoint[];
  usdc_burned: number;
  n_adversarial: number;
  verdict?: AttackVerdict | null;
  error?: string | null;
}

export interface RevenueReceipt {
  payer: string;
  amount_usdc: number;
  tx_ref: string;
}

export interface RevenueData {
  paid_queries: number;
  revenue_usdc: number;
  price_usdc?: number;
  recent?: RevenueReceipt[];
  note?: string;
}

export interface X402Info {
  facilitator: "dev" | "circle";
  price_usdc: number;
  scheme: string;
  network: string;
  pay_to?: string | null;
  payment_header: string;
  gated_endpoints: string[];
}

export interface CatalogAccepts {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  amount: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface CatalogAttestation {
  registry?: string;
  standard?: string;
  sellers_attested: number;
  services: string[];
  latency_slo_ms?: { min: number | null; max: number | null };
}

export interface CatalogProvider {
  name: string;
  tagline?: string;
  attestation?: CatalogAttestation | null;
}

export interface CatalogItem {
  resource: string;
  type: string;
  x402Version: number;
  accepts: CatalogAccepts[];
  metadata: {
    family: string;
    description: string;
    input?: unknown;
    output?: unknown;
    provider: CatalogProvider;
    units?: Record<string, string>;
  };
}

export interface CatalogData {
  x402Version: number;
  provider: CatalogProvider;
  items: CatalogItem[];
}

export interface MarketReceipt {
  seq: number;
  payer: string;
  amount_usdc: number;
  tx_ref: string;
  network: string;
  scheme: string;
}

export interface MarketReceiptsData {
  gate: "dev" | "circle";
  paid_queries: number;
  revenue_usdc: number;
  price_usdc: number;
  receipts: MarketReceipt[];
}

export interface BuyerRunReceipt {
  path: string;
  price_usdc: number;
  tx_ref: string;
}

export interface BuyerRunStatus {
  state: "idle" | "running" | "done" | "error";
  payer: string;
  total: number;
  done: number;
  spent_usdc: number;
  recent: BuyerRunReceipt[];
  error?: string | null;
}

/** One real Circle Gateway settlement originated from the UI (POST /api/buy). */
export interface LiveBuyResult {
  path: string;
  status: number;
  price_usdc: number;
  /** Gateway batch UUID (gateway-ref) or tx hash — classified by refKind(). */
  tx_ref: string;
  network: string;
  error?: string;
}

/** The real-buyer response + GET readiness probe. */
export interface LiveBuyResponse {
  live: boolean;
  /** A funded buyer key is present AND the seller is on the Circle gate. */
  buyer_ready: boolean;
  gate: "dev" | "circle" | null;
  payer: string | null;
  results: LiveBuyResult[];
  spent_usdc: number;
  cap_usdc: number;
  fetchedAt: number;
}

/** One wallet's USDC standing — native balance + (buyer only) Gateway deposit. */
export interface WalletBalance {
  role: "seller" | "buyer";
  address: string;
  /** Plain USDC balance (the native gas token on Arc), decimal string. */
  usdc: string | null;
  /** Gateway deposit — available spend + total + amount mid-batch (buyer only). */
  gateway?: { available: string; total: string; withdrawing: string } | null;
}

export interface BalancesData {
  buyer_ready: boolean;
  wallets: WalletBalance[];
  note?: string;
}

export interface ConsoleAct1 {
  status: number;
  headers: Record<string, string>;
  paymentRequirements?: unknown;
}

export interface ConsoleAct2 {
  status: number;
  body: unknown;
  paymentResponse?: string;
}

export interface ConsoleResult {
  live: boolean;
  act1: ConsoleAct1;
  act2: ConsoleAct2;
  paid: boolean;
}

export interface WebhookEvent {
  id: string;
  type: string;
  verified: boolean | null;
  received_at: number;
  subscription_id: string;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface WebhookFeed {
  events: WebhookEvent[];
  received: number;
  verify_available: boolean;
  note?: string;
}

/** Enriched /health — drives the StatusPill and live checklists. Loosely
 *  typed: the pill degrades gracefully if a field is missing. */
export interface HealthData {
  status?: string;
  gate?: "dev" | "circle" | string;
  chain_id?: number;
  oracle_address?: string | null;
  registry_address?: string | null;
  oracle_configured?: boolean;
  pay_to?: string | null;
  facilitator_host?: string | null;
  tape_source?: string;
  poster_last_tx?: string | null;
  attestor_address?: string | null;
  keeper?: KeeperStatus | null;
  [k: string]: unknown;
}

/** One check in the systems ledger.
 *
 *  `ok: null` is a first-class verdict — "could not read this" is a different
 *  fact from "this is wrong", and rendering the two the same is how a
 *  dashboard starts lying. */
export interface OpsCheck {
  ok: boolean | null;
  label: string;
  detail?: string | null;
  warn?: boolean;
}

export interface OpsSection {
  name: string;
  title: string;
  checks: OpsCheck[];
}

export interface OpsLedger {
  status?: "ok" | "pending" | string;
  /** epoch seconds of the pass that produced this */
  at?: number;
  duration_s?: number;
  sections: OpsSection[];
  failures?: number;
  warnings?: number;
  unknowns?: number;
  verdict?: "live" | "degraded" | "failed" | "unread" | string;
}

/** One keeper chore's standing.
 *
 *  `checked_*` is when the chore last RAN; `last_fire_*` is when it last did
 *  work. They differ by design — both chores stand down on cooldown, which is
 *  the healthy majority of ticks — and conflating them would make a keeper
 *  doing its job look like one that died an hour ago. Nulls mean never seen
 *  and must render as such, never as zero. */
export interface KeeperChore {
  checked_at: number | null;
  checked_age_s: number | null;
  verdict: string | null;
  last_fire_at: number | null;
  last_fire_age_s: number | null;
  every_s: number;
  next_due_s: number;
}

/** `enabled: false` is a deliberate configuration; `null` means the press
 *  could not answer for itself. Neither is "stalled". */
export interface KeeperStatus {
  enabled: boolean | null;
  heartbeat?: KeeperChore;
  roll?: KeeperChore;
}
