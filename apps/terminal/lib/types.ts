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
  /** The endpoint a visitor's wallet may be told about; absent on older payloads. */
  public_rpc_url?: string;
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
  /** Circle's identifiers for this chain; absent on a payload from an older API. */
  circle_blockchain?: string | null;
  gateway_chain?: string | null;
  private_mainnet?: boolean;
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
  /** Per-index seller scores from `/seller-scores/{index_id}`.
   *
   *  NOTHING IN THIS APP RENDERS THIS. The /sellers page did, and it was removed;
   *  seller grades live on /tape now, computed from the tape itself. The key is
   *  kept rather than dropped because `tests/test_snapshot_bundle.py` asserts the
   *  bundle carries it and the backend endpoint is real and documented on
   *  /developers — so this is the press's shape, which the Terminal mirrors
   *  whether or not it draws it. Said here so the next reader does not go looking
   *  for the component. */
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
   *  crawl was capped — `truncated` says which. Always present: it is one
   *  `readContract`, not a crawl. */
  seller_count: number;
  /** Only meaningful when the crawl ran; `false` on a summary read rather than
   *  a claim that rows were cut off when none were requested. */
  truncated: boolean;
  took_ms: number;
  /** ABSENT when the crawl was not requested, `[]` when it ran and the contract
   *  holds nothing. Three states rather than two, and the distinction is the
   *  same one `CatalogAttestation.sellers` documents: "we did not look" and
   *  "we looked and found none" are opposite claims, and a renderer that
   *  collapsed them would print "no attestations" for a read that never asked.
   *  `GET /api/registry?records=1` is what asks. */
  sellers?: RegistryOnchainRecord[];
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
  /** Whether `POST /demo/attack/start` would ACCEPT a run on this network, which
   *  is a different fact from whether this read succeeded. The start route is
   *  gated to testnet and this one is not, so on mainnet the status answers 200
   *  while a start 404s — and the page used to read the 200 as "the lab is live".
   *  Optional because an older press does not send it; `undefined` is treated as
   *  available, which is the pre-existing behaviour and the safe default for a
   *  deployment that predates the field. */
  available?: boolean;
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
  gateway_chain?: string | null;
  private_mainnet?: boolean;
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
   *  chain was read and holds nothing". Opposite claims, and the distinction is
   *  kept even though the panel that drew the two sentences went with /sellers:
   *  ShopFloor reads only `sellers_attested`, so nothing renders these rows
   *  today. Preserved because the catalog payload is the press's shape, not
   *  ours, and `RegistryDirectRead.sellers` makes the same three-way call. */
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
  /** Who was paid and what was bought — stamped since the seller fleet existed,
   *  so a unit price exists; absent on rows settled to the single platform wallet. */
  seller?: string;
  unit?: string;
  quantity?: number;
  /** The tier the buyer's AGENT-CARD earned on this purchase. Absent on rows
   *  recorded before the gate existed — which is not "anonymous", so the ticker
   *  marks only `carded` and `human`, never the absence. */
  tier?: "anonymous" | "carded" | "human";
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

/** One business the operator runs for, as a public surface may show it.
 *
 *  `name` is ABSENT, not empty, when the business has not consented — the
 *  Python side omits the key for that reason, and a UI that read an empty
 *  string would render an unnamed row as though the name were merely missing.
 *  Use `label`, which is the name when permitted and a stable pseudonym
 *  otherwise. */
export interface BusinessRow {
  slug: string;
  label: string;
  name?: string;
  treasury: string;
  tier: "own" | "network" | "cohort" | "oss" | string;
  chain: "mainnet" | "testnet" | string;
  consented: boolean;
  categories: string[];
  onboarded_at: number;
  /** False means the operator can price and meter for them but cannot spend. */
  spends: boolean;
  /** A demonstration, not a customer. Rendered as a chip wherever the business
   *  appears, and excluded from every traction figure server-side by
   *  `businesses.real()`. */
  sandbox?: boolean;
}

/** Payload of /api/operator/businesses. Counts are DERIVED from the list, so
 *  the number and the rows beside it cannot disagree. There is deliberately no
 *  field adding mainnet and testnet. */
export interface BusinessesPayload {
  businesses: BusinessRow[];
  counts: {
    businesses: number;
    consented: number;
    mainnet: number;
    testnet: number;
    spending: number;
    by_tier: Record<string, number>;
  };
}

/** One recorded decision. `rule` is the line naming the check that fired, and
 *  it is the field a reader should see first. */
export interface SpendDecision {
  at: number;
  obligation_id: string;
  vendor: string;
  category: string;
  billed_usdc: number;
  intent: "pay" | "hold" | "reroute" | "escalate" | "refuse" | string;
  rule: string;
  business?: string;
  resource?: string;
  metered_quantity?: number | null;
  vendor_quantity?: number | null;
  discrepancy?: number | null;
  /** `clear` · `flagged` · `unknown` · absent when no screen was offered.
   *  `unknown` must never render as `clear`: a screening service that timed out
   *  is not a clean bill of health, which is the rule `counterparty.py`
   *  enforces in the data. */
  screen_risk?: string;
  screen_matched?: string[];
  /** Which screen answered: `yente` · `denylist` · `off`. A verdict without its
   *  source is a claim without a basis — "clear" from a sanctions dataset and
   *  "clear" from a local list of zero are not the same assurance. */
  screen_backend?: string;
  par_usdc?: number | null;
  best_usdc?: number | null;
  over_par_bp?: number | null;
  saving_usdc?: number | null;
  reroute_to?: string;
  escalated?: boolean;
  paid_usdc?: number;
  tx?: string | null;
  notes?: string[];
  /* --- recorded on every decision, and rendered nowhere until now.
     Fifty-three fields go into the record `PolicyWallet` hashes, and the
     statement's own parity gate was blind to thirty-one of them because its
     fixture rows were hand-written and had fallen behind the dataclass. These
     are the ones an owner reading their own statement can act on. */
  /** `agent` or `owner`. THE PRODUCT'S CENTRAL CLAIM is "obligations settled
   *  without a human touching them", and a row that does not say who acted
   *  cannot support it either way. */
  actor?: string;
  /** What the agent advises the person to do, on a decision it escalated.
   *  Recorded, hashed, and invisible — which made "how often the human agreed"
   *  unanswerable by the human doing the agreeing. */
  recommended_intent?: string;
  /** How the money moved: `circle` · `eoa` · empty. Testnet payments went out
   *  from a raw EOA while the config resolved the agent role to Circle, and
   *  nothing anywhere could tell: the calldata is identical either way. */
  paid_via?: string;
  /** When the bill falls due, in unix seconds. The input to the timing check,
   *  and the denominator of "settled on time". */
  due_at?: number | null;
  /** The vendor's own reference. What a person reconciles against their own
   *  books, and the second half of the duplicate check. */
  invoice_ref?: string;
  /** An early-payment discount, as a FRACTION (0.02 == 2% off). */
  early_pay_discount?: number;
  /** The service's own unit ("$/1k tokens"). It decides which market was
   *  consulted, and the quantity beside it means nothing without it. */
  unit?: string;
  /** The meter discrepancy in money, on the vendor's own arithmetic.
   *  `discrepancy` is the same gap in the service's unit. */
  discrepancy_usdc?: number | null;
  /** How far over the going rate, in USDC. `over_par_bp` is the same fact as a
   *  ratio; this is it in the unit a reader budgets in. */
  over_par_usdc?: number | null;
  /** How many independent sellers the benchmark rested on. One is not a
   *  benchmark, which is the whole of `anchors/GAP.md`. */
  par_sellers?: number | null;
  /** Why there is no par: `NO_QUOTES` · `ONE_SELLER` ·
   *  `NO_INDEPENDENT_SELLER` · `NO_QUANTITY`. */
  par_reason?: string;
  /** Why the screen said what it said — the field that tells a denylist of
   *  zero addresses from a real dataset answering. */
  screen_reason?: string;
  /** The agreement check: `within` · `over_total` · `over_unit_price` ·
   *  `over_quantity` · `outside_window` · `no_commitment`. */
  commitment_verdict?: string;
  /** What the bill exceeded the written agreement by, in USDC. The figure
   *  `held_back_usdc` on the summary is made of. */
  over_commitment_usdc?: number | null;
}

/** One category's budget, as the CONTRACT states it. `configured: false` means
 *  the category exists in the registry but no budget has been set on chain —
 *  reported rather than omitted, because omitting reads as "no spend here". */
export interface SpendBudget {
  category: string;
  configured: boolean;
  cap_usdc?: number;
  spent_usdc?: number;
  remaining_usdc?: number;
  per_tx_limit_usdc?: number;
  period_start?: number;
  period_length?: number;
  /** Why it is unconfigured, when the press can tell. Absent means the honest
   *  "nobody has set a limit for this category yet"; present means something is
   *  wrong with the wallet itself and no figure about it can be trusted. */
  reason?: string;
}

/** What the wallet HOLDS, against what is dated and waiting on the owner.
 *
 *  Not the same question as `SpendBudget`, and the page had only that one. A
 *  budget is `cap - spent` from the contract's counters — PERMISSION — and it
 *  reads healthy on a wallet holding nothing. This is MONEY.
 *
 *  `held_usdc` is `null` when the balance could not be read, never 0: an
 *  unfunded wallet and an unreachable node are different facts, and `reason`
 *  says which. `covers_due` is `null` for the same reason.
 *
 *  Not a forecast. There is no burn rate and no runway here — it is what is
 *  held now against what is dated now, inside `horizon_days`. */
export interface SpendLiquidity {
  held_usdc: number | null;
  due_usdc: number;
  due_count: number;
  soonest_at: number | null;
  /** Escalations with no due date, counted apart and never inside `due_usdc`:
   *  "we do not know when this is due" is not "it is due later". */
  undated: number;
  horizon_days: number;
  covers_due: boolean | null;
  /** Why `held_usdc` is null, in prose. Empty when it was read. */
  reason: string;
}

/** Payload of /api/operator/statement.
 *
 *  `market_context` is in BASIS POINTS ONLY and carries its own note. The
 *  index's USDC figure is deliberately absent upstream: `anchors/GAP.md`
 *  records its reference level 20x to 1250x off real market prices, so the bp
 *  is scale-invariant and the dollars are not. Every USDC saving here comes
 *  from a reroute, where another seller was named at a lower price. */
export interface Statement {
  business: BusinessRow;
  period_days: number;
  as_of: number;
  spends: boolean;
  spend: {
    decisions: number;
    by_intent: Record<string, number>;
    decided: number;
    escalated: number;
    paid_usdc: number;
    saved_usdc: number;
    /** Realised, unlike `saved_usdc`: a bill outside an agreement we had
     *  written down, which did not leave the wallet. Never summed with it. */
    held_back_usdc: number;
    /** Realised too: a vendor billed for more than our own meter could find,
     *  and the bill did not go out. Never summed with `saved_usdc`. */
    overbilled_usdc: number;
    consumption_discrepancies: number;
    unmetered: number;
  };
  budgets: SpendBudget[];
  /** Beside the budgets, because permission and money are different questions
   *  and the statement carried only the first. */
  liquidity: SpendLiquidity;
  escalations: SpendDecision[];
  recent: SpendDecision[];
  market_context: {
    available: boolean;
    reason?: string;
    purchases?: number;
    benchmarked?: number;
    spent_usdc?: number;
    vw_slippage_bp?: number;
    basis?: string;
    note?: string;
  };
}

/** One business's row on the traction page. `moved_usdc` is what the operator
 *  PAID OUT; `priced_usdc` is what it assessed. They are different claims and
 *  the page keeps them apart. */
export interface TractionRow {
  slug: string;
  label: string;
  tier: string;
  chain: string;
  consented: boolean;
  spends: boolean;
  decisions: number;
  decided: number;
  escalated: number;
  moved_usdc: number;
  /** What the business was PAID, read from the sellers' own settlement tape
   *  rather than from our decisions. Never netted against `moved_usdc`: a
   *  business that received 10 and paid 10 did twice the work of one that did
   *  neither, and one net figure reports both as zero. */
  received_usdc: number;
  priced_usdc: number;
  recoverable_usdc: number;
  /** REALISED, unlike `recoverable_usdc` above: money a vendor asked for that
   *  did not leave the wallet. Totalled per chain on this page and shown per
   *  business on that business's own statement (/spend). */
  held_back_usdc: number;
  overbilled_usdc: number;
  discrepancies: number;
  unmetered: number;
  /** Paths a reader can open to check the arithmetic themselves. */
  ledger: string;
  statement: string;
  /** The same figures the aggregate reports, per business. */
  settled_by_agent: number;
  settled_by_owner: number;
  settled_on_time: number;
  settled_with_a_due_date: number;
  owner_resolutions: number;
  owner_agreed: number;
  risk_events_caught: number;
  paid_unscreened: number;
  addresses_screened: number;
  alerts_raised: number;
  alerts_resolved: number;
}

/** One of the six errors *Agents and Ledgers* says a trial balance cannot see,
 *  run. `searched` is what makes `found: 0` mean anything: a check that looked
 *  at nothing and found nothing is indistinguishable from a clean book. */
export interface LedgerCheck {
  error: string;
  question: string;
  searched: number;
  found: number;
}

/** One thing that balances and is still wrong. */
export interface LedgerFinding {
  error: string;
  /** Empty when the finding is about the period rather than a single row. */
  obligation_id: string;
  detail: string;
}

/** Payload of /api/operator/audit — the part the ledger cannot do for itself. */
export interface LedgerAudit {
  business?: string;
  period_days?: number;
  as_of: number;
  decisions: number;
  clean: boolean;
  /** Settlements with no payee, which cannot be attributed to any obligation.
   *  Reported apart because counting them as covered would be the very
   *  omission the first check exists to find. */
  unattributable_settlements: number;
  checks: LedgerCheck[];
  findings: LedgerFinding[];
  note: string;
}

/** Payload of /api/operator/traction. Derived at request time, never
 *  maintained, so no figure can drift from the rows beside it. There is
 *  deliberately no field adding mainnet and testnet. */
export interface TractionPayload {
  as_of: number;
  businesses: {
    businesses: number;
    consented: number;
    mainnet: number;
    testnet: number;
    spending: number;
    by_tier: Record<string, number>;
  };
  by_chain: Record<
    string,
    {
      moved_usdc: number;
      /** Read from the sellers' own tape, never netted against `moved_usdc`. */
      received_usdc: number;
      priced_usdc: number;
      /** HYPOTHETICAL: a cheaper offer existed and nothing was bought. */
      recoverable_usdc: number;
      /** REALISED, and the pair a bank statement would corroborate: money a
       *  vendor asked for that did not leave the wallet. Separate fields
       *  because one is "we had not agreed to this" and the other is "our own
       *  meter disagrees", and they are never added together. */
      held_back_usdc: number;
      overbilled_usdc: number;
    }
  >;
  work: {
    decisions: number;
    decided: number;
    escalated: number;
    by_intent: Record<string, number>;
    consumption_discrepancies: number;
    unmetered: number;
    /** RFB 4: "obligations settled on time without a human touching them".
     *  Counts, not a rate: `settled_on_time` is reported against the number of
     *  obligations that HAVE a due date, because one without a due date cannot
     *  be late and counting it punctual would be flattering nonsense. */
    autonomy: {
      settled_by_agent: number;
      settled_by_owner: number;
      settled_on_time: number;
      settled_with_a_due_date: number;
    };
    /** RFB 4: "how often the human agreed". The denominator is RESOLUTIONS, not
     *  escalations: an unanswered queue is an empty sample, not unanimity. */
    agreement: { owner_resolutions: number; owner_agreed: number };
    /** RFB 5: "risk events caught before the transaction". `paid_unscreened` is
     *  kept apart because "we could not check" is not "we caught something". */
    screening: { risk_events_caught: number; paid_unscreened: number };
    /** RFB 5, named for what we do. We screen at decision time; we do not
     *  monitor continuously, so this is `addresses_screened` and never
     *  `addresses_monitored`. */
    compliance: {
      addresses_screened: number;
      alerts_raised: number;
      alerts_resolved: number;
    };
  };
  per_business: TractionRow[];
  note: string;
}

/** Payload of GET /par (via `app/api/par/route.ts`) — one bill, priced against
 *  published third-party prices. The surface a stranger can exercise without
 *  onboarding, which is why every field a reader would want to CHECK is here
 *  rather than summarised.
 *
 *  `par.quotes[].url` and `.cite` arrived late: the dated files under `anchors/`
 *  had carried a source URL per row from the beginning, and both
 *  `par.market_basket` and `Par.as_dict` dropped it, so the comparison set was
 *  verifiable in principle and unopenable in fact. */
export interface ParQuote {
  /** A model id or a chain address — `openai/gpt-4o-mini`, not a name. */
  seller: string;
  price_usdc: number;
  /** `catalog` · `challenge` · `fill` · `market`. Only some of those name
   *  somebody a wallet could actually pay. */
  source: string;
  /** Is this seller one of ours? Disclosed, never filtered out. */
  first_party: boolean;
  /** A human name, when the source has one. Null for an address. */
  label: string | null;
  /** Where to go and check this price. Null for a fleet quote, which has no
   *  published page. */
  url: string | null;
  /** How to find the number once the URL is open: a quoted figure for a
   *  curated row, a path into the response for an API one. A URL without this
   *  points at a 464-model blob. */
  cite: string | null;
}

export interface ParCheck {
  unit: string;
  billed_usdc: number;
  quantity: number;
  vendor: string | null;
  vendor_supplied: boolean;
  /** `market` or `fleet` — WHOSE prices answered. A vendor of ours is priced
   *  against the fleet; a stranger against the market. It also silently
   *  becomes `fleet` when the basket is unusable or stale, which is why
   *  `basket.status` belongs on the page and not in a tooltip. */
  benchmarked_against: "market" | "fleet" | string;
  basket: {
    index_id: string;
    /** `ok` · `ABSENT` · `STALE` · `NO_ROWS`. */
    status: string;
    /** Unix SECONDS, unlike the envelope's `fetchedAt` in milliseconds. */
    fetched_at: number;
    rows: number;
    requested: number;
  };
  /** How far over the going rate, in basis points. THIS is the number to show.
   *  `verdict.verdict` answers a different question and disagrees on purpose:
   *  it reads `over_par` whenever material money sits at the CHEAPEST row, so a
   *  bill at exactly the market median comes back labelled over par while this
   *  field reads under 1 bp. The press's own tests assert both behaviours. */
  over_rate_bp: number | null;
  par: {
    resource: string;
    available: boolean;
    denomination: string;
    /** `NO_QUOTES` · `ONE_SELLER` · `NO_INDEPENDENT_SELLER` · `NO_QUANTITY`. */
    reason: string;
    par_usdc: number | null;
    best_usdc: number | null;
    best_seller: string;
    best_source: string;
    sellers: number;
    /** A count beside a count, never a share. */
    first_party_sellers: number;
    basis: string;
    quotes: ParQuote[];
  };
  verdict: {
    benchmarked: boolean;
    reason?: string;
    verdict: string;
    over_par_bp?: number | null;
    saving_usdc?: number | null;
    note?: string;
    [k: string]: unknown;
  };
  /** What the operator WOULD do with this bill. A dry run of the real ladder,
   *  not a separate opinion. */
  would: {
    intent: string;
    /** One line naming the check that fired. */
    rule: string;
    notes: string[];
    recommended_intent: string;
  };
}
