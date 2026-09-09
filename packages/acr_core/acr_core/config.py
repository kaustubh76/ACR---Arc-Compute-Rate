"""Global configuration.

Values here are load-bearing for the *math*, not just deployment — most
notably ``usdc_fee_bps`` and ``usdc_fee_flat``, which make the manipulation
bound (Pillar 3) a fixed number rather than a random variable. That determinism
is the whole reason the bound is computable on Arc.
"""

from __future__ import annotations

from pydantic import field_validator
from pydantic_core import PydanticUseDefault
from pydantic_settings import BaseSettings, SettingsConfigDict


class ACRSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ACR_", env_file=".env", extra="ignore")

    @field_validator("*", mode="before")
    @classmethod
    def _ignore_comment_pollution(cls, v):
        """Treat a leftover inline-comment value as unset.

        A ``.env`` whose empty placeholder lines carry a trailing ``# comment``
        (e.g. ``ACR_X402_PAY_TO=   # our wallet``) makes dotenv read the *comment*
        as the value — a non-empty string that silently selects the live path
        (Circle facilitator / wallet) instead of the safe dev/offline default.
        ``PydanticUseDefault`` (not ``""``) keeps this fail-safe for EVERY field
        type: a blank string would be a hard ValidationError on the numeric
        fields (``x402_price_usdc``, ``x402_max_timeout_seconds``, …), crashing
        every ``get_settings()`` on exactly the misconfig this tolerates.
        """
        if isinstance(v, str) and v.lstrip().startswith("#"):
            raise PydanticUseDefault()
        return v

    # --- estimator ---
    #: Trimmed-median trim fraction per tail (α-trim).
    trim_alpha: float = 0.10
    #: Target volume per volume-time bar, in USDC notional.
    bar_volume_usdc: float = 25_000.0
    #: Bootstrap resamples for the per-print confidence interval.
    ci_bootstrap: int = 500
    #: Confidence level for the CI (two-sided).
    ci_level: float = 0.95
    #: Per-cluster volume cap as a fraction of total window volume.
    cluster_volume_cap: float = 0.05
    #: Seed for the two stages that draw randomly: the Louvain partition and the
    #: bootstrap CI. It lived as a hardcoded default argument on both functions,
    #: reachable by no caller and recorded in no config, so the reproducibility
    #: claim rested on a number nobody could see. It joins `policy_hash`, because
    #: a different seed can produce a different partition and therefore a
    #: different set of exclusions.
    estimator_seed: int = 0
    #: Assumed Gateway batch width (seconds) — sets the deconvolution window.
    batch_interval_seconds: float = 300.0

    # --- Arc / USDC economics (make the bound a NUMBER) ---
    #: Proportional USDC transfer fee, basis points of notional.
    usdc_fee_bps: float = 1.0
    #: Flat USDC fee per transfer.
    usdc_fee_flat: float = 0.0001

    # --- chain ---
    arc_rpc_url: str = "http://127.0.0.1:8545"
    oracle_address: str = ""
    registry_address: str = ""
    #: Deployed ``ACRFutures`` address — the on-chain cash-settled future that
    #: settles against ``ACROracle``. Empty → the futures desk stays off (the
    #: term structure still renders from the maker model; no live positions).
    futures_address: str = ""
    #: Deployed ``FeedAccessAttestor`` — the contract that turns a paid x402
    #: query into an on-chain feed-access right. Written only by
    #: scripts/attest_feed_access.py; the service reads it so the Terminal can
    #: name the fourth contract instead of pretending it does not exist.
    #: Empty → the chip stays off rather than rendering a zero address.
    attestor_address: str = ""
    #: Deployed ``ACROracleV2`` — the oracle whose prints carry the cleaning
    #: policy hash, the estimation window and the human-denominated bound, so a
    #: print can be re-derived rather than trusted. Deployed ALONGSIDE v1, never
    #: instead of it: ``ACRFutures.oracle`` is immutable and the venue refuses a
    #: print older than two hours, so if v1 stopped printing every expired open
    #: series would be unsettleable and its collateral stranded. Empty → the
    #: poster posts to v1 only, exactly as before.
    oracle_v2_address: str = ""
    #: Deployed ``ReceiptMirror`` — the contract that puts an off-chain Gateway
    #: settlement on chain so the subgraph has a tape to index. Circle settles
    #: x402 off-chain and returns a batch UUID, not a transaction, so without
    #: this there is no settlement event on Arc at all and TCA has no basis.
    #: Empty → the mirror keeper stands down rather than writing nowhere.
    receipt_mirror_address: str = ""
    #: Private key the oracle-poster signs prints with (EIP-712) and relays.
    #: Empty → the in-service poster stays offline (logs the payload only).
    poster_private_key: str = ""

    # --- Arc network (verified testnet facts) ---
    #: Arc testnet chain id. Arc makes USDC a native system contract that is
    #: also the gas token, so gasless UX is intrinsic (no ERC-4337 paymaster).
    arc_chain_id: int = 5042002
    #: USDC on Arc — a native system contract address (NOT a deployed ERC-20).
    usdc_address: str = "0x3600000000000000000000000000000000000000"
    #: CAIP-2 network id; empty → derived as ``eip155:{arc_chain_id}``.
    arc_network_caip2: str = ""
    #: Block-explorer base URL (tx/address links in the Terminal).
    explorer_base: str = "https://testnet.arcscan.app"

    # --- Circle Developer-Controlled Wallets (empty → raw-key / offline) ---
    circle_api_key: str = ""  # PREFIX:ID:SECRET
    circle_entity_secret: str = ""  # 32-byte hex; SDK RSA-encrypts a ciphertext per call
    circle_wallet_id: str = ""  # the oracle poster / deployer wallet
    circle_wallet_set_id: str = ""  # for wallet creation / deploys
    #: The venue's two custody wallets, kept SEPARATE from the poster above so
    #: one credential is not four jobs. They must also be distinct from each
    #: other: ``ACRFutures.trade`` reverts "maker cannot take" when the caller is
    #: the series maker, so a single wallet cannot both quote and trade the book.
    #: Empty → the caller falls back to whatever ``build_signer`` selects, which
    #: keeps every offline/anvil path working unchanged. See docs/WALLETS.md.
    circle_owner_wallet_id: str = ""  # governance: may open a series
    circle_maker_wallet_id: str = ""  # the book's counterparty
    circle_taker_wallet_id: str = ""  # the hourly heartbeat
    circle_base_url: str = "https://api.circle.com"
    #: Optional base64 DER (SPKI) ECDSA P-256 public key to verify Circle webhook
    #: signatures fully offline. Blank → the receiver fetches the key from Circle
    #: by key-id (needs circle_api_key) and caches it.
    circle_webhook_public_key: str = ""
    #: JSONL append-log of inbound Circle webhook events (one event per line).
    #: Survives restarts and rehydrates the /webhooks/recent feed. Blank disables
    #: the file (in-memory only). Relative paths resolve from the process cwd.
    webhook_log_path: str = "data/webhook_events.jsonl"

    # --- the autonomous hedger's two PUBLIC identities --------------------
    # Addresses, not credentials: /hedger derives the agent's whole state from
    # public chain data plus the receipt ledger and holds no key for either.
    # They belong here so `.env` reaches them the same way it already reaches
    # `futures_address`. Until it did, `index_api/hedger.py` read raw
    # os.environ only — so `make snapshot` from a checkout wrote a bundle
    # carrying the venue the agent trades on beside an agent that reported
    # itself as not configured, and the offline edition lost its protagonist.
    # Two addresses, one agent (docs/WALLETS.md):
    #: the SCA — what ``ACRFutures.trade`` records as the taker, because it
    #: reads ``msg.sender``.
    hedger_address: str = ""
    #: the backing EOA — what the x402 settlement records as the payer, because
    #: EIP-3009 needs a signature ``ecrecover`` can verify and Circle signs with
    #: that EOA. Empty → the surface reports itself as not configured rather
    #: than inventing an empty agent.
    hedger_payer: str = ""

    # --- x402 / Nanopayments (empty facilitator url → dev-mode gate) ---
    #: Facilitator selection: "auto" (Circle iff URL + PAY_TO are set), "dev"
    #: (force the mock gate even when Circle vars are present — demo loops),
    #: or "circle" (force the real gate; fails closed if unconfigured).
    x402_mode: str = "auto"
    x402_facilitator_url: str = ""  # Circle Gateway facilitator base URL
    x402_pay_to: str = ""  # our receiving wallet (the seller)
    x402_scheme: str = "exact"  # EIP-3009; GatewayWalletBatched carried in `extra`
    x402_max_timeout_seconds: int = 60
    x402_resource_base: str = ""  # public URL base; empty → derived from the request
    #: Per-query price in USDC (sub-cent — a Nanopayment).
    x402_price_usdc: float = 0.0001
    #: JSONL append-log of REAL x402 settlements (one receipt per line) — the
    #: authoritative settlement tape ReceiptSource reads. Survives restarts and
    #: rehydrates /marketplace/receipts + /revenue. Blank (default) disables the
    #: file (in-memory only) — keeps tests + the dev gate from writing to disk;
    #: enable in the live seller (ACR_RECEIPT_LOG_PATH=data/x402_receipts.jsonl).
    receipt_log_path: str = ""
    #: Circle GatewayWallet contract (the EIP-712 verifyingContract buyers sign
    #: against — `extra.verifyingContract` in PaymentRequirements). Default is
    #: the shared testnet GatewayWallet (all Gateway testnet chains, incl. Arc).
    x402_gateway_wallet: str = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"

    # --- World / AgentKit human proofs (empty verifier url → dev-mode gate) ---
    #: Verifier selection, mirroring `x402_mode`: "auto" (AgentKit iff the URL and
    #: app id look real), "dev" (force the mock verifier — demo loops and tests),
    #: or "agentkit" (force the real one; fails closed if unconfigured).
    humanid_mode: str = "auto"
    #: AgentKit proof-verification endpoint. Empty → the dev verifier.
    humanid_verifier_url: str = ""
    #: The World Developer Portal app a proof must be scoped to. A proof minted
    #: for another app must not authorize anything here.
    humanid_app_id: str = ""
    #: THE LINKABILITY SECRET. `clusterId = keccak256(nullifier ‖ salt ‖ window)`,
    #: so anyone holding this and a nullifier can confirm which wallets are that
    #: human's. Never log it, never return it, never let it reach `forge` (script
    #: arguments land in contracts/broadcast/, which is committed). Must hash to
    #: the deployed HumanIdMirror's immutable SALT_COMMITMENT — `humanid.py`
    #: checks that and says so on /health, because a mismatched salt derives
    #: cluster ids that match nothing and reads exactly like "this human has
    #: never traded".
    humanid_salt: str = ""
    #: Demo identities come from the World ID Sandbox, not from Orb-verified
    #: users. Surfaced on /humanid/info so nobody has to take the README's word
    #: for what "verified human" means in this deployment.
    humanid_sandbox: bool = True
    #: keccak256 of the salt above — the value HumanIdMirror was deployed with.
    #: Set both and a mismatch is caught before it can produce a silent zero.
    humanid_salt_commitment: str = ""
    #: Deployed HumanIdMirror (make deploy-humanid). Empty → the resolver stands
    #: down instead of writing nowhere, and no wallet is ever human-backed.
    humanid_mirror_address: str = ""

    # --- World Chain (read-only) ---
    #: AgentBook lives on World Chain, not Arc, so it needs its own endpoint —
    #: this is the first reader in the codebase that points at a second chain.
    #: Empty → the fixture AgentBook, which is what the demo runs on until
    #: Sandbox access exists.
    world_rpc_url: str = ""
    agentbook_address: str = ""
    #: Which AgentBook to read: "auto" (the real one iff an endpoint or address
    #: is named), "fixture" (the demo roster), or "worldchain" (the live
    #: contract, which needs no configuration — address and RPC are constants).
    agentbook_mode: str = "auto"

    #: Comma-separated allowed CORS origins for the public API (so the dashboard
    #: /any browser can query it cross-origin). "*" = allow all (the testnet-demo
    #: default; the API serves public read data + the x402 gate); set to the
    #: Terminal's origin(s) to lock it down. Empty disables CORS entirely.
    cors_origins: str = "*"

    # --- The Graph ---
    #: Subgraph query URL (Subgraph Studio). Empty → every subgraph-backed
    #: surface reports itself unavailable rather than serving a zero, because a
    #: TCA of "0 bp" and a TCA of "we could not read the tape" are different
    #: facts and a reader must never see one rendered as the other.
    subgraph_url: str = ""
    #: Studio API key. SERVER-SIDE ONLY — it is why the read proxy exists; a key
    #: shipped to a browser is a key anyone can spend the quota of.
    graph_api_key: str = ""

    # --- tape source selection ---
    #: "sim" (default, calibrated simulator), "arc" (live Arc testnet USDC scan),
    #: "receipts" (the authoritative x402 settlement ledger — needs
    #: receipt_log_path populated by a live seller), or "graph" (the indexed
    #: settlement tape, which is the only source carrying a per-seller unit
    #: price and so the only one TCA can be computed from).
    tape_source: str = "sim"
    #: Events per service the simulator generates for the default sim tape. The
    #: rich local default (24k) is memory-heavy; small cloud instances (e.g. a
    #: 512MB Render free tier) should lower it (~3000) so the store build fits.
    sim_events_per_service: int = 24_000
    #: Sim economic horizon (seconds). Window density = events_per_service /
    #: (horizon/3600); the estimator needs a dense hourly window (~1000 events).
    #: On a small cloud box, shrink BOTH this and events_per_service together to
    #: keep density high (estimable) while cutting total events (memory). Default
    #: 24h matches acr_sim's SimConfig default.
    sim_horizon_seconds: float = 86_400.0
    #: Per-hour event count for the "Attack the Index" exhibit sims (attack.py)
    #: AND the live Attack Lab run (demo.py). These are the heaviest transient
    #: allocation in the app (a 12h error-series sim + two 1h attack sims), so a
    #: 512MB cloud box lowers it (~1250) to avoid an OOM spike. Floor ~800: below
    #: that the hour-0 cleaning stack leaves zero observations and the run errors
    #: (verified at 400). Default preserves the rich local exhibit.
    attack_sim_events_per_service: int = 2_500
    #: How many blocks back ArcSource scans for USDC transfer logs. Kept modest
    #: because USDC is Arc's native gas token → Transfer logs are dense; ArcSource
    #: also adaptively shrinks the range if the RPC still rejects it as too large.
    arc_tape_lookback_blocks: int = 800
    #: ArcSource attested-market mode (1 = on): decode a real unit PRICE from
    #: each transfer amount (price = notional / IndexSpec.arc_unit_qty), resolve
    #: each event's service from the seller's on-chain attestation, and DROP
    #: events from non-attested sellers — attestation earns index inclusion.
    #: 0 = legacy audit decode (price pinned to the reference level, everything
    #: resolved to INFERENCE).
    arc_attested_only: int = 0

    # --- service ---
    #: Seconds between index_api store refreshes / oracle-post cycles.
    refresh_seconds: float = 30.0

    # --- pricing / instrument ---
    #: Avellaneda–Stoikov inventory risk aversion.
    as_gamma: float = 0.1
    #: A-S order-book liquidity (fill-intensity decay). The quoter's base
    #: spread is (2/γ)·ln(1+γ/κ) of mid — κ=1.5 made that ~129% (a degenerate
    #: full-width corridor); κ=400 models the deep simulated book and lands
    #: the base spread at ~50bp, with the inventory term skewing on top.
    as_kappa: float = 400.0

    def caip2(self) -> str:
        """CAIP-2 network id for x402 PaymentRequirements (e.g. ``eip155:5042002``)."""
        return self.arc_network_caip2 or f"eip155:{self.arc_chain_id}"


_settings: ACRSettings | None = None


def get_settings() -> ACRSettings:
    """Process-wide singleton settings (env-overridable).

    NOTE: this is a mutable process-wide singleton — changing environment
    variables after the first call has no effect until ``reset_settings()``.
    Tests that tweak env should call ``reset_settings()`` to force a reload.
    """
    global _settings
    if _settings is None:
        _settings = ACRSettings()
    return _settings


def reset_settings() -> None:
    """Drop the cached settings so the next ``get_settings()`` re-reads env."""
    global _settings
    _settings = None
