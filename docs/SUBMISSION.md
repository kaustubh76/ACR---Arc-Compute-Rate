# ACR — Submission

**Arc / Circle 7-week Hackathon · Agentic Economy track · Halfway checkpoint 2026-07-27 · Ship-week update 2026-07-29 · Final update 2026-07-31**

> **ACR (Arc Compute Rate)** is "SOFR for machine commerce" — a manipulation-resistant reference-rate family that recovers the *latent constant-quality price of machine services* from the noisy, batched, adversarial payment exhaust on Circle's Arc L1, and publishes it as a live on-chain benchmark that contracts can settle against.
>
> *"Machine commerce just got its SOFR — and it prints its own attack cost."*

This is the one-page status for judges. For depth: [`Readme.md`](../Readme.md) (architecture blueprint), [`docs/methodology.md`](methodology.md) (estimator spec), [`IMPLEMENTATION.md`](../IMPLEMENTATION.md) (how to run), [`docs/IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) (full status), [`docs/presentation.md`](presentation.md) (the pitch deck — `make deck` renders HTML + PDF).

---

## 1. The three indices

| Index | Measures | Latest on-chain value (Arc testnet) |
|---|---|---|
| **ACR-INF** | Inference — $/1k tokens | **0.49236** |
| **ACR-GPU** | GPU compute — $/GPU-sec | **0.01110** |
| **ACR-DATA** | Data egress — $/MB | **0.00209** |

Every hourly print ships **three numbers, not one**: the rate, a **confidence interval**, and an **attack-cost-per-bp** — the USDC an attacker must burn to move the print by one basis point (e.g. ACR-INF attack-cost-per-bp ≈ **0.0094 USDC/bp**). Values read live from ACROracle at final submission (2026-07-31); posts run **in-cloud, hourly, signed by the Circle Developer-Controlled custody wallet** (e.g. `postPrint` [`0xa26c…643f`](https://testnet.arcscan.app/tx/0xa26c5977dcd8408f29e35f426f0ac6df0a26491ac39c056184a78bb1a7af643f)).

---

## 2. Progress vs the 7-week roadmap

**All seven weeks of scope are shipped.** The estimator, on-chain layer, adoption surface, red-team, and instrument layer are built and running — and the W6 instrument is now **live on-chain**: a cash-settled futures venue trading against the oracle print.

| Week | Focus | Deliverable | Status |
|---|---|---|---|
| **W1** | TAPE | Indexer on Arc + batching study | ✅ Done — `SimSource` (calibrated) + `ArcSource` (decodes real Arc USDC `Transfer` logs at `0x3600…0000`) behind one `TapeSource` interface |
| **W2** | ESTIMATOR v1 | Methodology paper + first live prints | ✅ Done — four-pillar estimator live; [`docs/methodology.md`](methodology.md) published |
| **W3** | ON-CHAIN | Registry + Oracle + invariant suite | ✅ Done — contracts deployed on Arc testnet; full Foundry suite incl. invariants (`fail_on_revert=true`) |
| **W4** ★ | ADOPTION | Sellers attest + x402 index API live | ✅ Done — x402 gate live on Circle Gateway; **real machine-to-machine settlement proven on-chain**; 4 seller attestations on-chain; public cloud API |
| **W5** | RED TEAM | Manipulation bound + attack own index | ✅ Done — `redteam/` wash + optimal-attack harnesses; attack-cost-per-bp on every print; CI-gated resistance claims |
| **W6** | INSTRUMENT | Weekly cash-settled future + A-S MM | ✅ **Live** — `ACRFutures` deployed on Arc ([`0x29d9…42fe`](https://testnet.arcscan.app/address/0x29d97c629a8278f7ec4218ab0bd8baa9182642fe)): a live ACR-INF series, 10× multiplier, cash-settling against the oracle print. The maker standing behind the book is a **Circle developer-controlled wallet** and an **autonomous agent** buys the print over x402 then trades on it; `acr_instrument` (Avellaneda–Stoikov MM) serves the term structure |
| **W7** | SHIP | Freeze + paper polish + rehearse | ✅ Done — repo 100% pushed; 4-job GitHub CI green; Terminal hardened (connection ladder, instant shell, direct on-chain reads) and redeployed; cloud posting re-enabled via Circle custody + keep-alive; deck re-rendered at final submission |

---

## 3. What's live right now (real, on Arc testnet — chain 5042002)

**Public URLs**
- **Dashboard (Terminal):** https://arc-compute-rate.vercel.app — never a blank page: the shell paints instantly and a six-tier *connection ladder* (`live → stale → waking the press → on-chain reads → archived`) keeps every value honestly labeled. When the free-tier API sleeps, the Terminal reads prints **directly from ACROracle with viem** (`/api/onchain`, CDN-cached) — even the fallback is on-chain truth.
- **Seller API:** https://acr-api-1fto.onrender.com — `/health` reports gate `circle`, 3 live indices, chain 5042002; `/onchain/{id}` serves the real on-chain print; `/x402/info`, `/marketplace/catalog`, `/marketplace/receipts`, `/webhooks/circle` all live. Hourly `postPrint` runs in-cloud via the **Circle Developer-Controlled custody signer**, kept awake by a 10-minute CI ping (`.github/workflows/keepalive.yml`) plus a post-on-wake catch-up if the press ever oversleeps its slot.

**On-chain contracts** (explorer: `https://testnet.arcscan.app`)
- **ACROracle** [`0x4f00e3BDd224F4c4b4958D54cD774E84B9092609`](https://testnet.arcscan.app/address/0x4f00e3BDd224F4c4b4958D54cD774E84B9092609) — hourly EIP-712-signed prints; `ecrecover` signer auth; monotone-ts + print-within-CI + bound-sanity enforced.
- **AttestationRegistry** [`0x23ae3E1A306824F0CBA0b6561cB7E5502f63dFb7`](https://testnet.arcscan.app/address/0x23ae3E1A306824F0CBA0b6561cB7E5502f63dFb7) — 4 real seller attestations (the hedonic-quality flywheel).
- **ACRFutures** [`0x29d97c629a8278f7ec4218ab0bd8baa9182642fe`](https://testnet.arcscan.app/address/0x29d97c629a8278f7ec4218ab0bd8baa9182642fe) — cash-settled futures on the print: Arc-native USDC collateral, 20% initial margin, settlement print must be ≤ 2 h old, socialized-loss clearing. Series roll automatically week to week (`make futures-roll` / `futures-lifecycle.yml`); desk + trade tape on the Terminal's `/curve`.
- **The Public Desk** — a reader opens a Circle **user-controlled** wallet in the browser (SCA on Arc; PIN ceremony in Circle's hosted UI, so the key exists only client-side and this server never holds it), takes a faucet stake, and trades the venue for real. Full lifecycle: `approve` → `postCollateral` → `trade` → **`withdrawCollateral`**, plus permissionless `settle` at expiry. Every action is a server-minted challenge the reader authorizes with their PIN; guardrails (one drip per session-derived wallet, live margin-feasible sizing against *both* sides' checks, expiry gating, rate limits) are server-side. Gas Station sponsorship confirmed from the ERC-4337 `UserOperationEvent` paymaster, not from a fee field. **Honest framing:** the stake is our testnet grant and the maker on the other side is our own bot — the wallet, the PIN, the margin maths, the fills and the settlement are real.
- Poster/owner EOA `0x33189c643774ED2713EbFf5A6923e5fa42b96eE8`; Circle Developer-Controlled custody signer `0x8366968f84a343CF70941EBe858428643d825cb0` (verified `setSigner` + Circle-signed+relayed `postPrint`).

**Proven x402 settlement (real USDC moved)**
**Two distinct payers** have settled real USDC through Circle Gateway against this gate — the count that matters, because revenue from a single wallet we control proves plumbing rather than demand. The durable, in-repo artifact is [`services/index_api/index_api/receipts_live.jsonl`](../services/index_api/index_api/receipts_live.jsonl): **10 Gateway-settled receipts**, scheme `exact`, `eip155:5042002`, $0.0001 each, deduped by `tx_ref`. It lives under `services/` rather than `data/` because that directory is in both `.gitignore` and `.dockerignore`, so a file there reaches neither the repo nor the image — an earlier version of this claim was false for exactly that reason.

The payers are the CI buyer agent (`0x784e6d2d…`, 7) and the **autonomous hedger's Circle agent wallet** (`0x71e140d9…`, 3). That second address is the agent's *backing EOA*: the x402 `exact` scheme is EIP-3009 and the facilitator `ecrecover`s it, so Circle signs with an EOA even though the agent's smart account (`0x1Dc707E3…`) is what `ACRFutures.trade` records as the taker. Two addresses, one agent — see [`docs/WALLETS.md`](WALLETS.md).

Counters survive a restart: production has no persistent disk, so `/revenue` read `paid_queries: 0` over a gate that had genuinely been paid until the archive shipped inside the image. Measured across two independent restarts, it holds and does not double. Circle's own CLI also paid the gate end-to-end (§4). Settlement refs are Gateway **batch UUIDs** (GatewayWalletBatched) — the honest transaction story is *x402 payments + Gateway batch settlements + the oracle's own `postPrint` txs*, not "N L1 transactions."

**Verify any of it yourself:** `make verify-live` (every pillar of the deployed product, one exit code), `make verify-claims` (re-measures every number these docs assert, including this page and the deck), `make print-gaps` (the on-chain press cadence against the 120-minute settle window), `make x402-capture` (fold new settlements into the durable archive).

---

## 4. Circle Agent Stack coverage (all 5 pillars → code)

| Circle pillar | Where in ACR |
|---|---|
| **Agent Nanopayments** (Gateway x402) | Seller gate `services/index_api/index_api/x402.py` → `/v1/x402/verify`+`/settle` on `gateway-api-testnet.circle.com`; scheme `exact`/GatewayWalletBatched on `eip155:5042002` |
| **Agent Wallets** | **All three Circle wallet models, live.** Buyer `apps/agent/` pays via `@circle-fin/x402-batching` `GatewayClient` (raw EOA); the oracle signs prints via Circle **Developer-Controlled** Wallets (`packages/acr_oracle_client/signer.py`); and any reader trades the futures venue from a Circle **user-controlled** SCA on the Public Desk — their PIN is the only thing that can sign, Gas Station pays (`services/index_api/index_api/desk.py`, `apps/terminal/components/chain/PublicDesk.tsx`) |
| **Agent Marketplace** | `GET /marketplace/catalog` (Bazaar-shaped listings + on-chain attestation provenance); `GET /marketplace/receipts` (public settlement tape); Terminal `/exchange` |
| **Circle CLI** | `make circle-login / circle-wallet / circle-fund / circle-deposit / circle-balance` — `docs/agent-runbook.md`. **Proven end-to-end**: Circle's own CLI buyer settled against the deployed gate (`circle services inspect …/prints` → `payable`; `circle services pay` from a faucet-funded agent wallet paid $0.0001 and received the full prints payload) |
| **Circle Skills** | `circle-skills` Claude Code plugin (`make skills-install`) |

---

## 5. Verification evidence (re-run at final submission — 2026-07-31)

Every gate below was executed fresh; results captured verbatim. The same gates
run on every push as **GitHub Actions CI — 4 jobs (python / contracts / agent /
terminal), all green** (`.github/workflows/ci.yml`).

| Gate | Command | Result |
|---|---|---|
| Lint | `ruff check packages services scripts redteam` | ✅ All checks passed |
| Desk preflight | `make desk-preflight` | ✅ CLEAR TO RUN — series life, margin capacity both directions, custody funding, faucet slots |
| Desk round trip on Arc | `make desk-e2e` → `make desk-evidence` | ✅ stake → collateral → trade → **withdraw**, confirmed by four independent witnesses (venue balance, contract state, wallet balance, `CollateralWithdrawn` + paymaster) |
| Real-tape audit | `scripts/tape_audit.py` | ✅ measured: ~18.5k real Arc settlements collapse to **one** price, so no index is publishable from them — the `sim` label is earned, not assumed |
| Glossary coverage | `scripts/check_glossary_coverage.py` | ✅ 386/386 diagram terms defined |
| Python suite | `pytest packages services tests` | ✅ **273 passed** — including 9 anvil-gated on-chain tests that CI now genuinely runs (a node is started in the job) rather than silently skipping |
| Resistance gate | `scripts/eval.py --hours 12 --check` | ✅ all 4 checks PASS |
| Contracts | `forge test -vvv` | ✅ **50 passed** (17 oracle + 10 registry + 16 futures + 7 invariants, `fail_on_revert=true`) |
| Buyer agent | `npm run build && npm test` | ✅ tsc clean, **10/10** |
| Terminal | `npm test && next build` | ✅ **55/55 node tests** (8 suites: buy plan · connection ladder · oracle codec · futures codec · edition · glossary · plain-edition coverage · desk phase) + clean build (8 pages + 15 API proxies) |
| Buyer-SDK interop | `make interop` | ✅ **12/12** (our 402 parses exactly as Circle's `GatewayClient` — re-run 2026-07-31 against the **deployed** gate) |
| On-chain read | `make verify-testnet` | ✅ chain id + contracts' bytecode + 3 live prints read from Arc (+ `cast code` shows bytecode at ACRFutures) |
| GitHub CI | push to `main` | ✅ 4/4 jobs green |

**The headline claim — manipulation resistance** (`make demo`, $8,000 wash-attack budget, 36,000 adversarial authorizations, attacker burned **$147.60**):

| Index | naive VWAP moved | ACR moved | Resistance |
|---|---|---|---|
| ACR-INF | **+110.8%** | +0.20% | **562×** |
| ACR-GPU | +107.1% | −1.02% | 105× |
| ACR-DATA | +122.5% | +2.39% | 51× |

Over the 12-hour evaluation series (`make eval`): attack-window error — **naive VWAP 5703.9 bp vs ACR 124.1 bp = 46× more resistant**. These numbers are **CI-gated** (`make eval-gate`, `tests/test_claims.py`) so they cannot silently drift.

---

## 6. Honesty tiers (stated plainly)

The system labels every value's provenance truthfully:
- **`sim`** — calibrated simulator (the published default; parameters are open). SOFR itself was methodology-first, liquidity-second — same defense.
- **`gateway-ref`** — a real Circle Gateway settlement (batch UUID).
- **`tx`** — an on-chain transaction hash (e.g. a custody-relayed `postPrint`).

Deliberately **not** faked: raw Arc USDC transfers and flat x402 query-fee flow carry no compute-price signal, so they are **not** fed into the indices as prices — the manipulation-resistant estimator's cleaning stage correctly rejects that degenerate single-seller pattern. The settlement ledger is an authoritative **audit** tape, not price discovery. Sim stays the labeled default.

---

## 7. How to run it

```bash
make setup      # uv sync · forge install · npm install
make ci         # lint + full test suite + eval gate (mirrors GitHub CI)
make demo       # the "Attack the Index" money-shot
make api        # x402-gated seller API on :8000
make terminal   # ACR Terminal on :3000
```
Full go-live sequence on Arc testnet: [`docs/TESTNET_RUNBOOK.md`](TESTNET_RUNBOOK.md); cloud deploy: [`docs/DEPLOY.md`](DEPLOY.md).

---

## 8. Known limitations (honest)

- **Cloud cold start.** The public API runs on a 512MB free tier that can still restart. Mitigated three ways: a 10-minute keep-alive ping, a post-on-wake oracle catch-up, and — on the dashboard side — the Terminal's connection ladder, which paints its shell instantly, labels the tier truthfully ("waking the press · ~60s"), and serves **direct ACROracle reads** until the full feed returns. Not a correctness issue at any tier — the fallback path is itself on-chain data.
- **Public Arc RPC rate-limits** (429/413) under heavy scanning; mitigated with caches, adaptive range-shrink, and paced sequential reads with a retry pass on the Terminal's direct-read route.
- **Next.js pinned at 14.2.x** — upgrade to 15 to clear the Dec-2025 advisory before a fully public production launch.
