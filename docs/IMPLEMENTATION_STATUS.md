# ACR — Implementation Status & Session Handoff

> **Read this first.** This is the single "what has been built, what's real vs. simulated, and where to look" context doc for ACR. It exists so a new session can act on the codebase without re-scanning the whole product. For depth, see [`Readme.md`](../Readme.md) (architecture blueprint), [`docs/methodology.md`](methodology.md) (estimator spec), and [`IMPLEMENTATION.md`](../IMPLEMENTATION.md) (zone map + go-live how-to).

---

## TL;DR (current status)

- **What it is:** ACR ("the Arc Compute Rate") estimates the *latent constant-quality price of machine services* from noisy, batched, adversarial Arc payment exhaust, and publishes it as a manipulation-resistant on-chain reference rate that contracts settle against. Built for the Arc/Circle Agentic-Economy hackathon.
- **State:** A well-structured, **honestly-documented** system. Three big sessions are done: (1) a core-infra **hardening** pass that made the docs' claims actually true, (2) a **real Circle/Arc live-wiring** pass, and (3) a **Circle Agent Stack completion** pass — all five pillars (Nanopayments, Agent Wallets, Agent Marketplace, Circle CLI, Circle Skills) now exist in the repo, with the buyer side implemented against the *verified* Gateway API and buyer-SDK shapes. The system is now **deployed and live**: the Terminal at [arc-compute-rate.vercel.app](https://arc-compute-rate.vercel.app), the seller API at [acr-api-1fto.onrender.com](https://acr-api-1fto.onrender.com) (hourly Circle-custody-signed oracle posts), real x402 queries settled through Circle Gateway (durable in-repo receipts with Gateway batch UUIDs — `services/index_api/index_api/receipts_live.jsonl`, 11 rows; the `data/` copy is local-only because that directory is gitignored *and* dockerignored; live-run tallies live on the ephemeral free-tier ledger), a live Circle webhook endpoint with P-256 signature verification, and — new at final submission — the **`ACRFutures` venue on Arc** (`0x29d9…42fe`, three books — ACR-INF, ACR-GPU, ACR-DATA — traded hourly by the in-process keeper, cash-settling against the oracle print). The offline simulator path remains the credential-free default for `make test`.
- **Tests green:** **352 Python tests** (incl. anvil-gated on-chain integration), **60 Foundry tests** (incl. the ACRFutures suite + invariants), **84 node tests** (`apps/terminal`, a dedicated CI job) + the `apps/agent` node suite, `ruff` + glossary checks clean, terminal + agent `tsc`/`next build` clean. Hermetic — `make test` needs no credentials and no Circle SDK.
- **Deliberately deferred:** ERC-4337 Paymaster (Arc USDC *is* the gas token → gasless is intrinsic), Next.js 15 upgrade, and a couple of Circle-doc specifics isolated behind config (see **Landmines**). Git: the repo is **100% committed and pushed** to `github.com/kaustubh76/ACR---Arc-Compute-Rate`; GitHub CI runs 4 green jobs (python / contracts / agent / terminal); four scheduled workflows keep the live venue alive — `keepalive` (which now runs `make verify-live`, proving every pillar rather than pinging a host), `futures-heartbeat`, `futures-lifecycle` (settle + roll) and the dispatch-only `futures-recover`.

---

## The product in one page

**One estimand:** the latent price `p*_t` of a machine service — $/1k tokens (ACR-INF), $/GPU-sec (ACR-GPU), $/MB (ACR-DATA). Everything is judged by whether it reduces bias/variance of `p̂_t` as an estimate of `p*_t`.

**Four pillars (the estimator, `packages/acr_estimator`):**
1. **Observation model** (`observation_model.py`, `pipeline.py`) — Gateway batching is a convolution; a Kalman filter + RTS smoother deconvolves it.
2. **Hedonic adjustment** (`hedonic.py`) — regress log-price on attested quality features → a constant-quality rate (Case-Shiller for compute).
3. **Manipulation cost bound** (`bound.py`) — the least USDC to move the trimmed median by 1bp, priced through Arc's deterministic fee → "attack cost per bp" printed next to the rate.
4. **Instrument** (`packages/acr_instrument`) — a cash-settled ACR-Weekly future + Avellaneda–Stoikov market maker.

Plus a **robust core** (`robust.py` trimmed weighted median + bootstrap CI, `cleaning.py` funding-graph contamination filter) and **robustness diagnostics** (`robustness.py`).

**On-chain (`contracts/`):** `ACROracle.sol` (EIP-712-verified signed prints, staleness, pause, 2-step ownership) and `AttestationRegistry.sol` (replay-proof seller metadata). **Distribution (`services/index_api`):** an x402-gated FastAPI + a Next.js Terminal (`apps/terminal`).

---

## Repo file map (where to look, don't scan)

### `packages/acr_core` — shared foundation
| File | Purpose |
|---|---|
| `config.py` | `ACRSettings` (pydantic-settings, `ACR_` prefix): estimator knobs, deterministic USDC fees, **chain + Circle + x402 + Arc** fields, `caip2()`. `get_settings()`/`reset_settings()` singleton. |
| `types.py` | Domain models: `TapeEvent`, `SellerAttestation`, `ACRPrint` (CI-invariant), `Quote`, `ModelClass`, `Service`. |
| `indices.py` | The 3-index registry + `spec_for`/`index_for_service` (reference levels). |
| `mathutils.py` | `weighted_median`, `weighted_quantile`, `trimmed_weighted_median`, `alpha_trim_mask`, `breakdown_point`, `gross_error_sensitivity`, `volume_time_bars` (all guarded). |

### `packages/acr_estimator` — the product (four pillars)
`bound.py` (cap-aware manipulation bound), `cleaning.py` (4-defense funding-graph filter), `hedonic.py` (Pillar 2), `observation_model.py` (Kalman/RTS), `pipeline.py` (wires stages → `ACRPrint` + `PrintDiagnostics`), `robust.py` (trimmed median + CI), `robustness.py` (per-print robustness diagnostics), `indexer.py` (volume-time bars).

### `packages/acr_sim` — calibrated simulator (data source #1)
`simulator.py` (OU latent + honest Poisson flow + batching), `adversary.py` (wash-flow: self-deals + reciprocal funding + pure-sybil ring), `processes.py` (OU), `sellers.py` (quality premia), `batching.py` (Gateway operator).

### `packages/acr_tape` — `TapeSource` ingestion
`base.py` (ABC), `sim_source.py` (lazy sim wrapper), `arc_source.py` (**real** config-driven Arc-testnet decode).

### `packages/acr_oracle_client` — sign + publish on-chain
`client.py` (`OracleClient`, `PostPayload`, `sign_print`, `ORACLE_ABI`), `registry.py` (`RegistryClient`, `attest`/`attest_with_sig`), `signer.py` (**`Signer` abstraction**: `LocalKeySigner` / `CircleWalletSigner` / `build_signer`).

### `packages/acr_instrument` — Pillar 4
`future.py` (cash-settled future), `market_maker.py` (Avellaneda–Stoikov).

### `services/index_api` — x402-gated API
`app.py` (FastAPI + lifespan refresh/poster loop + `PaymentRequired` exception handler), `store.py` (rolling-window `PrintStore`, `default_source()`), `x402.py` (**`Facilitator` base + `DevFacilitator` + `CircleFacilitator`**, `build_payment_requirements`, `facilitator_endpoint` — all shapes verified against the real Gateway API + buyer SDK), `marketplace.py` (**Bazaar-shaped `/marketplace/catalog` + `/marketplace/receipts` ledger + `get_registry` seam**), `poster.py` (oracle-poster job), `onchain.py` (oracle reader), `attack.py` (Terminal "Attack the Index" cache).

### `apps/agent` — the buyer agent (TypeScript)
The machine side of the marketplace: `src/payer.ts` (`DevPayer` mock-header buyer with zero Circle imports + `GatewayPayer` over the official `@circle-fin/x402-batching` `GatewayClient`, lazy import, chain `arcTestnet`), `src/catalog.ts` (discovery from `/marketplace/catalog`, `--require-attested` filter), `src/main.ts` (`runAgent` loop: round-robin, spend cap, receipts), `src/interop.ts` (**12 field-level checks that our 402 parses exactly the way `GatewayClient.pay()` parses it**), `src/receipts.ts`, node:test suite with stubbed fetch. `make agent` (offline) / `make agent-live` (Arc testnet).

### `scripts/` & `redteam/`
`eval.py` (VWAP-vs-ACR series + **`--check` gate**), `run_demo.py`, `run_pipeline.py`, `gen_snapshot.py` (Terminal snapshot), `onchain_demo.py` (anvil round-trip), `deploy_circle.py` (**Circle Smart Contract Platform deploy**); `redteam/wash_attack.py` (paired attack), `redteam/optimal_attack.py` (validates the bound is attainable).

### `contracts/` (Foundry, solc 0.8.24, `via_ir`)
`src/ACROracle.sol`, `src/AttestationRegistry.sol`; `test/{ACROracle,ACROracleInvariant,AttestationRegistry}.t.sol`; `script/Deploy.s.sol`.

---

## Work log — Session 1: core-infra hardening

**Audit verdict:** solid demo skeleton, but 8 load-bearing guarantees were *documented, not implemented*. Each was fixed and the docs corrected to measured reality.

| # | Was (doc claim ≠ code) | Now |
|---|---|---|
| 1 | Manipulation bound priced an **undefended** median (injected wash appended raw) | **Cap-aware defended bound** (`bound.py`) against a cleaning-evading sybil adversary: cap enters as a required cluster/identity count + funding-leg fee. `redteam/optimal_attack.py` runs the priced attack through real `clean()` to prove it's attainable. |
| 2 | Kalman "Pillar 1" collapsed to `tilt=last−mean` clipped ±5%, CI silently widened | **Principled shrinkage** (`pipeline.py`): variance-shrunk end-of-window tilt whose uncertainty flows into the CI (holds by construction). Bars built from **cleaned** weights (zero-weight wash can't shift them). |
| 3 | "EIP-712 signed prints" existed only in docstrings | **Real EIP-712**: `ACROracle.postPrint` verifies the recovered signer; `client.sign_print` signs the `Print` struct; a digest-parity test proves Python ≡ Solidity. |
| 4 | Headline resistance numbers **never asserted**; committed eval showed 72% not ">100%" | **Eval gate** (`scripts/eval.py --check`) + `tests/test_claims.py`; docs rewritten to the *measured* two-scenario numbers (demo VWAP 107–122% / ACR <3% / 51–562×; 12h eval ~57% / ~1.2% / ~46×). |
| 5 | 2 of 4 cleaning defenses were **dead code** (adversary never emitted that flow) | `adversary.py` now emits self-deals + on-tape reciprocal funding legs + a pure-sybil ring; **all four defenses fire** and the attack is neutralized (`test_cleaning.py`). |
| 6 | Oracle **brickable** by a bad timestamp; no staleness; "hourly prints" false in the running service | `ACROracle`: timestamp-skew bound, `isStale`/`latestPrintWithAge`, `setPaused`, two-step ownership. API: lifespan **refresh loop** (prints evolve, `vol` becomes real) + poster scheduling; `store.py` rolling-window + lock/copy-on-write. |
| 7 | Registry `attestWithSig` **replayable forever** | `AttestationRegistry`: per-seller **nonce + deadline** (replay + expiry tested). |
| 8 | `breakdown_point()` a constant; `gross_error_sensitivity` unused | Per-print **`RobustnessDiagnostics`** (`robustness.py`): single-cluster flip fraction, leave-one-community-out influence, clusters/identities required — surfaced in the API/Terminal. |

**Also:** numerics (`observation_model` `solve`+jitter instead of raw `inv`; `hedonic` correct sqrt-weight fallback + real R²; `mathutils`/`robust` input guards; MM ask clamp); the PrintStore threadpool **race** (lock + copy-on-write); FastAPI **lifespan**; bounded x402 counters; Terminal SSR crash-guard + fetch timeout + an **honest snapshot** (removed a stale anvil oracle address); **CI** (`.github/workflows/ci.yml`, `make ci`). Python 41→77 tests, forge 15→32.

### Honesty notes established this session (do not regress)
- **Sybil-zeroing, not the cluster caps, is the real resistance.** Uniform cap-scaling of one honest community is median-invariant; the cap contributes ~0 to stability. This is *why* the bound models a sybil-flag-evading adversary.
- Eval gate thresholds are the **measured numbers minus a safety margin** (attack ACR err <300bp, VWAP err >4000bp, ratio ≥20×) — they must stay below reality, not aspirational.

---

## Work log — Session 2: real Circle/Arc live-wiring

**Scope:** full live wiring of Nanopayments/x402, Circle Developer-Controlled Wallets, and Arc-live tape + Circle Contracts deploy. **Paymaster is intentionally OUT** (Arc USDC is the native gas token). **Hard invariant:** every new path keeps the offline-tolerant fallback, so `make test` stays green with zero Circle env and without the Circle SDK installed.

**Verified Arc/x402/Circle facts the code is built against:**
- Arc testnet: chain id **5042002**, RPC `https://rpc.testnet.arc.network`, USDC is a **native system contract** at `0x3600000000000000000000000000000000000000` and is the **gas token**; CAIP-2 `eip155:5042002`.
- x402 v2 headers: `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`; scheme `exact` = EIP-3009; Circle Nanopayments uses the `GatewayWalletBatched` domain; facilitator exposes `POST /verify` + `/settle`.
- Circle Wallets: Python SDK `circle-developer-controlled-wallets`; supports EIP-712 typed-data signing + contract execution; Arc is supported.

| Phase | What was built |
|---|---|
| **P0 Config** | Circle/x402/Arc fields + `caip2()` in `config.py`; `circle` optional extra on `acr-oracle-client`; **`.env.example`** (copy-safe); a hermetic root **`conftest.py`** (disables `.env`, strips `ACR_*` so tests never depend on a local `.env`). |
| **P1 Signer** | New `signer.py`: `Signer` protocol, `LocalKeySigner` (byte-identical to the old raw-key path), `CircleWalletSigner` (custody EIP-712 sign + contract-execution; lazy SDK), `build_signer`, `full_eip712_json`, `split_signature`. `OracleClient`/`RegistryClient` now depend on the `Signer` (raw-key back-compat kept — anvil round-trip re-verified). |
| **P2 x402** | `x402.py` split into `Facilitator` base + `DevFacilitator` (mock header, default) + `CircleFacilitator` (real x402 v2: b64 `PAYMENT-REQUIRED` → httpx `/verify`+`/settle` → `PAYMENT-RESPONSE`, **fail-closed**). `require_payment` reads canonical + legacy headers. |
| **P3 ArcSource** | Real config-driven decode: `USDC_TRANSFER_ABI` default + `EIP3009_AUTHORIZATION_ABI` marker + field-map + service resolver; Arc defaults; `store.default_source()` honors `ACR_TAPE_SOURCE`. |
| **P4 Deploy** | `scripts/deploy_circle.py`: Circle Smart Contract Platform deploy/import + `setSigner`, with `--dry-run`; pure request-builders (tested). |
| **P5 Docs** | `IMPLEMENTATION.md` status notes + `methodology.md` §7 live-wiring paragraph. |

---

## Work log — Session 3: Circle Agent Stack completion

**Scope:** close the missing pillars of Circle's Agent Stack (announced May 2026): a real buyer (Agent Wallet + Nanopayments client), an agent marketplace, Circle CLI ops, Circle Skills — and fix the x402 gate to the **verified** Gateway API. Hard invariant preserved: every path keeps the offline-tolerant fallback; `make test` green with zero Circle env.

| Phase | What was built |
|---|---|
| **P1 Gateway correctness** | `x402.py` rebuilt against confirmed shapes: `facilitator_endpoint()` → `POST /v1/x402/verify`+`/settle` (was bare `/verify`); `_parse_verify` → `{isValid, invalidReason}`, `_parse_settle` → `{success, transaction, network, payer, errorReason}` (reasons surfaced in the 402 detail; settle `payer` authoritative); challenge became `PaymentRequired` carrying the spec-shaped `{x402Version, accepts:[…]}` **both** as JSON body and as the b64 `PAYMENT-REQUIRED` header (the buyer SDK parses the header); confirmation set on `PAYMENT-RESPONSE` + `X-PAYMENT-RESPONSE`, dev gate included; price → `ACR_X402_PRICE_USDC`. |
| **P1b Interop (verified against `@circle-fin/x402-batching` v3.2.0 source)** | The SDK selects the accepts option by `network == eip155:<chainId>`, **`amount`** (v2 key — we emit `amount` + `maxAmountRequired` both), and **`extra == {name: "GatewayWalletBatched", version: "1", verifyingContract: <GatewayWallet>}`** — our old extra was wrong on all three; fixed + new `ACR_X402_GATEWAY_WALLET` (testnet default `0x0077…19B9` from the SDK's own chain config). Retry header `Payment-Signature`; response read from `PAYMENT-RESPONSE` → `{transaction}`. `apps/agent`'s `npm run interop` re-checks all 12 fields against a running API: 12/12 PASS. |
| **P2 Buyer agent** | `apps/agent/` (see repo map): DevPayer offline / GatewayPayer live, catalog discovery, attestation-aware buying, spend cap, receipts + summary. Verified end-to-end offline: discover 13 listings → 8 paid queries → ledger + tape show them. |
| **P3 Marketplace** | `marketplace.py`: 13 concrete resources across the 5 gated families, Bazaar item shape (`{resource, type, x402Version, accepts, metadata:{description, input/output schemas, provider}}`), `provider.attestation` summarized live from `AttestationRegistry` (ERC-8004-style anchor; `null` offline — honest), `/marketplace/receipts` ledger with monotone `seq` (no wall-clock — Fixing rules). Registry seam `get/set/reset_registry` mirrors `onchain.get_reader`. |
| **P4 Terminal** | `/exchange` ("The Exchange"): listings sheet + the settlement tape (5s SWR ticker) + run-the-buyer block, in The Fixing idiom; Masthead nav; Developers page lists the marketplace endpoints and notes the console is the dev-mode mock; console pays at the gate's advertised price (`/x402/info`) instead of a hard-coded `0.0001`. |
| **P5 CLI + Skills** | Makefile: `circle-login/-wallet/-fund/-deposit/-balance` (interactive wrappers, never CI; `--type local` because the x402 `exact` scheme is EOA-only) + `agent`/`agent-live`/`interop`/`test-agent`/`skills-install`. Circle Skills installed as the **`circle-skills@circle` Claude Code plugin v1.1.0** (user scope — `~/.claude/plugins/cache/circle/…`), incl. `use-agent-wallet`, `fund-agent-wallet`, `pay-via-agent-wallet`, `use-circle-cli`. `docs/agent-runbook.md` is the live runbook (wallet → faucet → Gateway deposit → seller env → `make agent-live` → cross-check with `circle services pay`). |
| **P6 Docs/CI** | CI grown to **4 jobs** — python / contracts / `agent` (node 20: `npm ci` + tsc + node:test, no secrets) / terminal — plus a **keepalive cron workflow** (`.github/workflows/keepalive.yml`); Readme "Circle Agent Stack in ACR (judge's map)" table + honest batch-settlement transaction narrative; this doc. |
| **P9 Live floor buyer** | The Exchange's "Run the buyer" is no longer a static instruction table: `services/index_api/index_api/buyer_demo.py` + `POST /demo/buyer/start` / `GET /demo/buyer/status` drive N REAL x402 two-act exchanges through the app's own gate (full ASGI round-trips through `require_payment`/the facilitator/the `PaymentRequired` handler — the exact contract external agents hit; `apps/agent` is the out-of-process twin). Single-flight + stall watchdog (mirrors `demo.py`); refuses on the Circle gate (mock header fails closed there — honest 409 pointing at `apps/agent`). Terminal: `/api/demo/buyer` proxy, `useBuyerRun()` (700ms poll while running), a "Release the floor buyer — 20 paid queries" button on `/exchange` with live progress + per-settlement `PaymentToast` + tape/revenue SWR refresh per settle; the previously-orphaned `ChainFactsStrip` mounted as "Only computable on Arc". 5 new hermetic tests (`test_buyer_demo.py`). E2E-verified: button path via Next proxy → 6/6 settled → ledger `seq`-aligned `0xfloor-*` receipts. On the Circle gate the Terminal now carries a **LIVE buyer** instead — real Gateway settlements originated from the UI (3 per run, hard $0.01 cap; `docs/agent-runbook.md` §4b). |
| **P8 UI reflection pass** | The Terminal now reflects the full backend: `make snapshot` regenerated `fallback.json` with every bundled section (marketplace 13 listings + receipts — regenerated from the live deployment; the bundled receipts now LEAD with the two real Circle Gateway settlements from `data/x402_receipts_live.jsonl` (genuine UUIDs, `scheme: exact`), with the `sim-N` rows behind them — the Terminal deep-links a real ref via `TxLink` and renders sim ones plain, so the archived edition finally carries evidence that x402 settled for real — revenue ring, x402 descriptor, chain block) so the offline "archived edition" is content-rich, never blank; `OracleProvenance` mounted on `/index/[id]` (arcscan-linked oracle/signer/postPrint-tx panel — the TESTNET_RUNBOOK's promised outcome; shows the **live testnet deploy** — the "undeployed — awaiting testnet" state applies only pre-deploy); `SettlementTape` mounted on `/exchange` (real `0x…` settlement hashes deep-link via `TxLink`, `dev-N`/`sim-N` refs stay plain, "· simulated tape ·" marker on bundled data); `/exchange` badges/empty-states key on each section's own envelope `live` flag; new drift guard `tests/test_snapshot_bundle.py` derives the required snapshot keys from the real `embed_bundle_sections` — a forgotten `make snapshot` is now a red test, not a silent blank page. |
| **P7 Adversarial review fixes** | A multi-agent review over the session's changes confirmed and fixed: ① the `_ignore_comment_pollution` validator now raises `PydanticUseDefault` instead of returning `""` (a comment-polluted NUMERIC env var — e.g. `ACR_X402_PRICE_USDC= # note` — previously crashed every `get_settings()`); ② `require_known_index` dependency runs BEFORE `require_payment` on the four parametrized gated endpoints — a buyer is never charged for `/curve/BOGUS` (was: verify+settle **then** 404); ③ dev gate rejects non-finite mock amounts (`nan`/`inf` would poison the revenue counter and 500 JSON endpoints); ④ dev `tx_ref` ordinal now matches the ledger `seq`; ⑤ agent spend cap: pre-flight price probe (refuses to start if price > cap) + settled payments are never dropped from the books (cap stops *before* the exceeding payment); ⑥ console `randPayer()` was deterministic (every visitor was `0xagent-3a18f6`) — now random post-hydration; ⑦ Developers-page price labels read the live `/x402/info` price instead of hard-coded `$0.0001`; ⑧ receipts `seq` clamped ≥ 1; sub-atomic price guard in `atomic_amount`. |

---

## Current subsystem state (real vs. simulated vs. deferred)

| Subsystem | Status | Where | Note |
|---|---|---|---|
| Tape (data source) | **Simulator by default**, real Arc decode available | `acr_tape/sim_source.py`, `arc_source.py` | `ACR_TAPE_SOURCE=arc` switches to live USDC-`Transfer` decode. `size`/`service` aren't on-chain → resolver default. |
| Estimator (4 pillars) | **Real** | `acr_estimator/*` | Runs identically on sim or Arc tape via `TapeSource`. |
| Manipulation bound | **Real, cap-aware** | `bound.py` + `redteam/optimal_attack.py` | Prices a cleaning-evading adversary; validated attainable. |
| Contracts | **Real** (EIP-712 verify, staleness, pause, 2-step; registry nonce/deadline) | `contracts/src/*.sol` | 50 forge tests incl. invariants. |
| Oracle signing | **Real** — raw key (dev) **or** Circle wallet (prod) | `oracle_client/signer.py` | `postPrint` verifies the *signer*, so any relayer submits. |
| Futures venue (W6) | **Real** — collateral, margin, fills, settlement on-chain | `contracts/src/ACRFutures.sol`, `oracle_client/futures.py` | Series roll + settle automated (`make futures-roll` / `futures-settle`, `futures-lifecycle.yml`). The book is first-party: our bot makes both sides. |
| Public Desk (user-controlled wallets) | **Real** — Circle user-controlled SCA, PIN ceremony in-browser | `services/index_api/index_api/desk.py`, `apps/terminal/components/chain/PublicDesk.tsx` | Full lifecycle incl. **withdraw**; the key exists only client-side, so every action is a server-minted challenge the reader signs with their PIN. Quote correctness proven against a real contract (`tests/test_desk_onchain.py`), not a stub. |
| x402 payment gate | `DevFacilitator` default (mock); **`CircleFacilitator` real, Gateway-API-verified** | `services/index_api/x402.py` | Circle path selected by `ACR_X402_FACILITATOR_URL` + `ACR_X402_PAY_TO` (or `ACR_X402_MODE`). Endpoints `/v1/x402/verify`+`/settle`; descriptor interop-checked against the buyer SDK. |
| Agent marketplace | **Real** (catalog + receipts ledger + Terminal /exchange) | `services/index_api/marketplace.py`, `apps/terminal/app/exchange/` | Attestation provenance live when a registry is configured; honest `null` offline. |
| Buyer agent | **Real** — DevPayer offline / `GatewayClient` live | `apps/agent/` | `make agent` (no creds) / `make agent-live` (funded EOA + Gateway deposit). |
| Circle CLI + Skills | **Wired** (interactive ops + installed skill pack) | `Makefile`, `docs/agent-runbook.md` | CLI is email-OTP interactive → runbook-only, never CI. Skills = `circle-skills` Claude Code plugin. |
| Contract deploy | Foundry/anvil (local) + **Circle SCP** (`deploy_circle.py`) | `scripts/`, `contracts/script/` | Circle path needs creds; `--dry-run` works offline. |
| API service | **Real + deployed** (lifespan refresh, poster loop, rolling-window store, locks) | `services/index_api/*` | Live at https://acr-api-1fto.onrender.com — posts **hourly** via the Circle Developer-Controlled custody signer (post-on-wake + 10-min keepalive). |
| Terminal | **Real + deployed** (SSR + honest snapshot) | `apps/terminal/` | Next 14.2.x pinned. Live at https://arc-compute-rate.vercel.app — six-tier connection ladder, direct `ACROracle` reads via `/api/onchain`, LIVE Circle buyer ($0.01 cap). |
| Paymaster / ERC-4337 | **Deferred by design** | — | Arc USDC is the gas token → gasless intrinsic. |

---

## Key design decisions the next session must NOT silently undo

1. **`ACROracle.postPrint` verifies the EIP-712 signer, not `msg.sender`.** This is what lets a Circle-custodied wallet sign while any relayer submits. Don't "simplify" it back to `onlyPoster`.
2. **The manipulation bound's threat model is a cleaning-*evading* sybil** (fresh clusters > `SYBIL_MAX_SIZE`, unattested, one-directional). Pricing the cap alone models the wrong attack.
3. **Sybil-zeroing (not cluster caps) is the real resistance mechanism** — see the hardening honesty note above.
4. **`ArcSource` cannot observe `size`/`service` on-chain** — the authoritative tape is the facilitator's own settlement log. The on-chain decoder is a fallback with a documented reference-level `size` derivation (recovers notional, fabricates no price).
5. **Offline-tolerance is invariant:** absence of config selects the offline/dev path everywhere. Never make a Circle/RPC path mandatory.
6. **The Circle SDK is a lazy, optional extra** — imported only inside `CircleWalletSigner`/`_RealCircleDeployer` when no client is injected. Tests inject fakes; the SDK must never import in CI.
7. **The eval gate thresholds are measured-with-margin** and CI-gated — keep them honest.
8. **The root `conftest.py` makes the suite hermetic** by disabling `.env` + stripping `ACR_*`. Don't remove it (a local `.env` would otherwise leak into tests).

---

## Tests & verification

- **Python: 303 tests** (incl. 9 anvil-gated on-chain tests — CI starts a node so they run; they skip only on a machine without anvil) (incl. anvil-gated on-chain integration (skipped without anvil) — the anvil round-trip in `test_onchain.py`), spanning core, estimator, instrument, oracle_client, sim, tape, services (incl. x402-circle + marketplace + webhooks + terminal-bundle), and `tests/`.
- **Foundry: 50 tests** (`ACROracle` 17, `AttestationRegistry` 10, `ACRFutures` 16, invariants 5 + 2 with `fail_on_revert=true`).
- **Node: 81 terminal tests** (`apps/terminal`, node:test — a dedicated CI job) + the `apps/agent` suite (node:test with stubbed fetch — DevPayer two-act flow, rejection, price parsing, catalog filters, spend-cap stop + price-over-cap refusal) + `tsc` type-checks for agent and terminal.
- **Commands:** `make test` (py + forge + agent), `make lint` (ruff), `make ci` (lint + test + eval gate), `make eval-gate` (headline-claim gate), `make demo` / `make pipeline` / `make eval`, `make interop` (402-descriptor vs buyer-SDK check, needs `make api`). On-chain: `make anvil` then `make onchain` (deploy → EIP-712 signed posts → byte-identical read-back → settle).
- **Hermetic:** everything above runs credential-free; Circle live paths are exercised with mocked HTTP (`httpx.MockTransport`, exact `/v1/x402/*` paths + confirmed response shapes) and injected fake Circle clients.

---

## Known landmines

- **The repo `.env` is REAL now** (it was once a broken `.env.example` copy whose inline `# comments` parsed as values). It was copied from an early `.env.example` draft whose inline `# comments` after `=` get parsed as the *value* (e.g. `circle_wallet_id = "# the oracle..."`). It holds live Circle credentials and funded keys, and is what drives every real transaction in this repo. Tests stay credential-free via `conftest.py`. It is gitignored — keep it that way, and never echo its values.
- **Resolved in Session 3 (no longer flags):** facilitator base URL = `https://gateway-api-testnet.circle.com` with `/v1/x402/verify`+`/settle` appended by `facilitator_endpoint()`; verify/settle JSON field names confirmed from the Gateway API reference; the `extra` block confirmed **from the buyer SDK source** = `{name: "GatewayWalletBatched", version: "1", verifyingContract: <GatewayWallet>}` (testnet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`, configurable via `ACR_X402_GATEWAY_WALLET`).
- **Still flagged (confirm at first live use):** the real Arc event signature + `size`/`service` derivation (`ArcSource`); Circle CLI verb/flag spellings (`circle <resource> --help` — the CLI is v0.0.x and moving); the `_RealCircleDeployer` request shapes in `deploy_circle.py`. **Resolved live:** the Circle custody signer (`signer.py`) posts hourly in production, and the Gateway round trip has been run for real — x402 paid queries settled through the deployed gate; the durable proof is the Gateway batch UUIDs in `services/index_api/index_api/receipts_live.jsonl` (`data/` is gitignored, so a receipt there reaches neither the repo nor the image; run tallies on the free-tier ledger are ephemeral).
- **Git: fully committed.** The entire repo — including `apps/terminal`, `docs/`, `.github/` (CI), and the architecture `.excalidraw` canvases — is committed and pushed to `github.com/kaustubh76/ACR---Arc-Compute-Rate`; CI runs 4 green jobs (python / contracts / agent / terminal) plus the keepalive cron workflow.

---

## How to go live (Circle/Arc)

Condensed — full steps in [`IMPLEMENTATION.md`](../IMPLEMENTATION.md) and [`.env.example`](../.env.example):
1. `uv sync --extra circle`; fill a clean `.env` (Circle key/entity-secret/wallet, `ACR_X402_FACILITATOR_URL`, `ACR_X402_PAY_TO`, `ACR_ARC_RPC_URL`, `ACR_ARC_CHAIN_ID=5042002`).
2. Fund the Circle wallet with a little Arc USDC (native gas); `uv run python scripts/deploy_circle.py` (deploy or `--import-by-address`, auto-`setSigner`); export `ACR_ORACLE_ADDRESS`.
3. `make api` → `curl -i /prints` returns 402 + b64 `PAYMENT-REQUIRED`; pay via a Circle Gateway buyer wallet → 200 + `PAYMENT-RESPONSE` txHash. the poster loop Circle-signs each print. (`ACR_TAPE_SOURCE=arc` would read real Arc settlements, but yields no publishable index — see `scripts/tape_audit.py`; the deployment stays on the labelled `sim` tape.)

---

## Deferred / next-steps backlog

- ~~One real Arc-testnet round trip~~ — **done**: real x402 paid queries settled against the deployed gate; durable Gateway batch UUIDs in `services/index_api/index_api/receipts_live.jsonl`, refs on the /exchange tape (`docs/agent-runbook.md`).
- Circle Agent Marketplace directory: form **submitted 2026-08-04** (`MARKETPLACE-LISTING.md`) — awaiting Circle's response; the Discovery API still lists zero Arc services, so the claim is *submitted*, not *listed*.
- `ArcSource` service resolution via the facilitator settlement log (the authoritative service source).
- Cap-denominator methodology refinement (cap as fraction of *surviving* rather than *raw* volume) — tightens the bound; noted in `methodology.md` §6.
- Next.js 15 upgrade (clears the Dec-2025 advisory the Terminal pins around).
- ~~First git commit~~ — **done**: the repo is 100% committed and pushed; CI green (4 jobs + keepalive).

---

## Pointers
- [`docs/GLOSSARY.md`](GLOSSARY.md) — **plain-English** definitions (with analogies) of every term on the diagram + a jargon-free ①→⑩ walkthrough. Start here if the terminology is dense.
- [`docs/methodology.md`](methodology.md) — the estimator specification (estimand, pillars, bound, eval).
- [`IMPLEMENTATION.md`](../IMPLEMENTATION.md) — blueprint→zones map + live-wiring notes.
- [`Readme.md`](../Readme.md) — the architecture blueprint (the excalidraw canvas README). The diagram now carries a "PLAIN ENGLISH" glossary panel; render it headlessly with `scripts/preview_excalidraw.py`.
- [`docs/SUBMISSION.md`](SUBMISSION.md) — the judge-facing submission status (gates, evidence, deployed URLs).
- [`docs/DEPLOY.md`](DEPLOY.md) — the cloud deployment state (Vercel Terminal + Render seller API) and how to operate it.
