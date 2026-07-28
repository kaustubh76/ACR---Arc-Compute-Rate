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

export interface TerminalData {
  prints: Record<string, PrintRow>;
  history?: Record<string, HistoryPoint[]>;
  sellers?: Record<string, SellerRow[]>;
  attack: {
    per_index: AttackIndexRow[];
    series: SeriesPoint[];
    usdc_burned: number;
    n_adversarial: number;
  };
  oracle?: string | null;
  chain?: ChainFactsData | null;
  /* bundle-only sections (snapshot enrichment — absent from live /terminal/data) */
  marketplace?: { catalog: CatalogData | null; receipts: MarketReceiptsData | null } | null;
  revenue?: RevenueData | null;
  x402?: X402Info | null;
  x402_exchange_sample?: ExchangeSample | null;
}

/** Every proxy response is wrapped: `live` is false when serving the bundled
 *  snapshot (the "archived edition"). */
export interface Envelope<T> {
  live: boolean;
  data: T;
  fetchedAt: number;
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
  [k: string]: unknown;
}
