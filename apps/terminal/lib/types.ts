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
  /** The same bound priced in verified humans rather than wallets.
   *
   *  ABSENT, NOT ZERO. ACROracleV2 accepts 0 as "not computed" and enforces
   *  `humanAdjustedBound == 0 || >= attackCostPerBp`, so a zero here means the
   *  press did not compute it — never that humans are as cheap to buy as
   *  wallets. Rendering 0 as a dollar figure would publish the one claim the
   *  contract invariant exists to forbid. */
  human_adjusted_bound?: number | null;
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
  /** See OnchainPrint.human_adjusted_bound — absent or 0 means NOT COMPUTED. */
  human_adjusted_bound?: number | null;
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
  /* What the estimator actually DID this hour. Optional because the archived
     bundle predates them — an old snapshot must still render, just with less
     to say. Same names as scripts/eval.py so the live run and the CI eval
     cannot drift. */
  acr_ci_lo?: number;
  acr_ci_hi?: number;
  attack_cost_per_bp?: number;
  /** Observations the hour delivered, before cleaning. */
  n_raw?: number;
  /** Observations that survived cleaning and reached the estimate. */
  n_obs?: number;
  /** How much of the hour the cleaner removed. ~56% quiet, ~95% under attack —
   *  the defence biting, as a number a reader can watch. */
  cleaned_pct?: number;
  sybil_clusters?: number;
  /** Real estimator time for the hour, excluding the loop's own pacing. */
  step_ms?: number | null;
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
  /** HumanIdMirror — the identity layer's contract on Arc. Same rule as the
   *  attestor: null until configured, and omitted rather than zero-addressed. */
  humanid_address?: string | null;
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
  /** Rounds that have finished, newest first. Absent on the archived tier. */
  settled?: FuturesSettledRow[];
  source?: "press" | "chain" | "bundle";
}

/** A series that ran its whole life: opened, traded, expired, cash-settled.
 *
 *  Its own row type rather than a `FuturesDeskRow` with flags, because the two
 *  describe different things. A desk row is a market you can trade, carrying
 *  live inventory and open interest; this is a closed fact, and `settle`
 *  deletes every position, so an open-interest field here would describe the
 *  clearing rather than the round that was traded. Only what `getSeries`
 *  itself returns is in here. */
export interface FuturesSettledRow {
  series_id: number;
  index_id: string;
  /** The oracle print frozen at settlement, in index units. */
  settlement_price: number;
  expiry_ts: number;
  multiplier: number;
  maker: string;
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
  /** USDC per 1.0 of index value, per contract. Feeds `contractNotional`. */
  multiplier: number | null;
  /** The venue's last recorded fill price on the agent's series. `ACRFutures`
   *  fills every trade at `oracle.latestValue(indexId)` and emits it, so this IS
   *  an oracle print — the one the contract itself used — checkable at
   *  `mark_block`. Null when no fill on that series is inside the tape's reach.
   *  Present even when `fills` is empty: the heartbeat keeps trading the book
   *  while an agent sitting at its mandate holds. */
  mark: number | null;
  mark_block: number | null;
  position_contracts: number | null;
  gap_contracts: number | null;
  collateral_usdc: number | null;
  paid_queries: number | null;
  spent_usdc: number | null;
  fills: FuturesTradeRow[];
  /** The agent's OWN settled payments, newest first, at most ten. Null means the
   *  ledger was not read; [] means it was read and this payer is not in it.
   *  Those are different claims and the panel prints different sentences. */
  receipts: HedgerReceipt[] | null;
}

/** One settled payment made BY the hedger, projected to the keys both ledger
 *  paths carry. The live ring adds `seq` and the committed archive adds
 *  `resource`; neither is here, because a field present on one path and absent
 *  on the other is how a panel learns to render "…" for a real value. */
export interface HedgerReceipt {
  /** Circle Gateway batch reference (a UUID), or a `dev-`/`sim-` marker. */
  tx_ref: string;
  amount_usdc: number;
  network: string;
  /** Epoch seconds. Null on a row written before the field existed. */
  settled_at: number | null;
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

/** One `AttestationRegistry` record as the CHAIN returned it, on demand.
 *
 *  Deliberately not the same shape as `CatalogAttestationRow`, which is the
 *  press's summary of the same thing. This carries what the press drops and
 *  what makes the read a reading rather than a restatement: the raw `uint8`
 *  codes beside their names, the `bytes32` before it was decoded, and the
 *  contract's own `timestamp`. */
export interface RegistryOnchainRecord {
  seller: string;
  service_code: number;
  service: string;
  class_code: number;
  model_class: string;
  latency_slo_ms: number;
  schema_id_hex: string;
  schema_id: string;
  /** Unix seconds, as the contract stores it. */
  attested_at: number;
}

/** The answer to one press of "read it from the chain".
 *
 *  `block` and `took_ms` are the point of the payload, not metadata: they are
 *  what distinguishes a live reading from a re-render of the card above it. */
export interface RegistryDirectRead {
  registry: string;
  chain_id: number;
  block: number;
  /** `sellerCount()` as returned, which may exceed `sellers.length` if the
   *  crawl was capped — `truncated` says which. */
  seller_count: number;
  truncated: boolean;
  took_ms: number;
  sellers: RegistryOnchainRecord[];
}

/** One demo seller, derived from its repo label and then looked up on Arc.
 *
 *  The two counts are different numbers and must never share a label. `txs` is
 *  the ACCOUNT nonce (`eth_getTransactionCount`) and reads 0: this key has never
 *  sent a transaction. `filed` is the CONTRACT's own signature nonce
 *  (`AttestationRegistry.nonces`), which counts how many signed records have
 *  been filed FOR this seller by somebody else. Together they are the
 *  meta-transaction, visible.
 *
 *  `filed` is a count, not a flag, and the live registry proves it: two of the
 *  four read 2 on the day this shipped, because their record was filed again.
 *  Nothing here or on the page may say "filed once".
 *
 *  Both are nullable, and null is not zero. The derivation is offline and the
 *  counts are not, so they fail separately; when Arc will not answer, these come
 *  back null with `chain_unread` set. Rendering null as 0 would manufacture the
 *  exact result the page is trying to prove. */
export interface DerivedSellerCheck {
  label: string;
  address: string;
  /** Account nonce. Null means the read did not happen, not that it is zero. */
  txs: number | null;
  /** `nonces(seller)` on the registry. Null means the read did not happen. */
  filed: number | null;
}

/** The answer to one press of "check the four keys". */
export interface SellerKeyEvidence {
  registry: string;
  chain_id: number;
  /** Null only when the chain leg failed; the derivation still stands. */
  block: number | null;
  /** True when the addresses below were derived but Arc would not answer, so
   *  every `txs`/`filed` is null. */
  chain_unread: boolean;
  took_ms: number;
  sellers: DerivedSellerCheck[];
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
  /** idle | simulating | estimating | done. `simulating` is the blocking tape
   *  build that runs BEFORE hour 0 and used to look like a hang. */
  phase?: string;
  started_at?: number | null;
  elapsed_s?: number | null;
  /** Known before the first hour, so counters can be a fraction of a whole. */
  n_adversarial_total?: number | null;
  usdc_total?: number | null;
  /** Why the budget knob does not move the outcome: the cap binds. */
  trade_cap?: number | null;
  budget_affords?: number | null;
  pace_s?: number;
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

/** One record as `AttestationRegistry` holds it, straight off the wire. The keys
 *  are the press's snake_case rather than a UI shape: this is the same object a
 *  discovery crawler reads at /marketplace/catalog. `service` and `model_class`
 *  stay `string` because the press owns those enums — a narrow union here would
 *  break the build the day a fourth service is added, for no gain. */
export interface CatalogAttestationRow {
  seller: string;
  service: string;
  model_class: string;
  latency_slo_ms: number;
  schema_id: string;
}

export interface CatalogAttestation {
  registry?: string;
  standard?: string;
  sellers_attested: number;
  /** The rows behind `sellers_attested`. OPTIONAL, and that is load-bearing:
   *  a bundle snapshotted before this field existed carries the count with no
   *  rows. `undefined` means "archived before we served them"; `[]` means "the
   *  chain was read and holds nothing". Opposite claims, so the panel prints a
   *  different sentence for each rather than collapsing them into "empty". */
  sellers?: CatalogAttestationRow[];
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
  /** ISO-8601, stamped when the seller last rebuilt its catalog (i.e. at
   *  deploy). On the wire since the catalog existed; typed only now, because
   *  a listing that cannot say when it was last published is a listing a
   *  crawler has to re-read every time. */
  lastUpdated?: string;
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
  /** Unix seconds. Absent on rows settled before the field existed. */
  settled_at?: number;
  /** The catalog resource this settlement bought, e.g. `/curve/ACR-GPU`.
   *
   *  Optional and often absent, deliberately: the seller stamps it at settle
   *  time but most archived rows predate the stamp, and the builder omits the
   *  key rather than sending "". So a listing with no attributed sales means
   *  "the tape cannot say", never "nobody bought it" — the two are different
   *  claims and the page must not merge them. */
  resource?: string;
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
