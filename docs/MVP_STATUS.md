# ACR — MVP Status & Gap Analysis

**Arc Compute Rate — "SOFR for machine commerce."** A manipulation-resistant reference-rate family that recovers the *latent constant-quality price of machine services* from noisy, batched, adversarial payment exhaust on Circle's Arc L1, and publishes it on-chain with its own attack cost attached.

> **Read this for:** how complete each part is, what's live, what's simulated vs real, and exactly what's left. For depth: [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) (build log), [`SUBMISSION.md`](SUBMISSION.md) (judge one-pager), [`methodology.md`](methodology.md) (estimator spec).

*Snapshot: 2026-08-05. Chain: Arc testnet 5042002.*

---

## 0. TL;DR — how good is it?

**Unusually complete for a hackathon build, and genuinely live on Arc testnet.** All seven roadmap weeks are built; the core loop (estimator → contracts → x402 distribution → buyer agent) is proven end-to-end with real USDC moved through Circle Gateway, and the instrument layer **trades on-chain** — three `ACRFutures` books cash-settling against the print, with readers on the other side from their own Circle wallets. The dashboard is a polished, honestly-labeled 8-page terminal. **The gap to "production" is hardening, not core functionality** — the honest asterisk is that the maker on every book is still first-party (§7).

| Dimension | State |
|---|---|
| Core product (estimator + bound + red-team) | ✅ Complete, real math, CI-gated |
| On-chain (Oracle + Registry + x402 + webhooks) | ✅ Deployed & live on Arc testnet |
| Dashboard (Terminal UI) | ✅ MVP-ready, 6 pages, live on Vercel |
| Tests / CI | ✅ **445 passed** python + 114 forge + 95 node, 6-job CI green |
| Instrument layer (futures/MM) | ✅ **Live-traded** — three books on Arc (ACR-INF, ACR-GPU, ACR-DATA), a keeper rotating hourly fills, and readers trading from their own Circle wallets |
| Production hardening | 🟡 Paid cloud tier, Next 15, 3 FLAGs to verify |

---

## 1. The three indices

| Index | Measures | Latest on-chain value |
|---|---|---|
| **ACR-INF** | Inference — $/1k tokens | ~0.49 |
| **ACR-GPU** | GPU compute — $/GPU-sec | ~0.011 |
| **ACR-DATA** | Data egress — $/MB | ~0.002 |

Every hourly print ships **three numbers**: the rate, a **confidence interval**, and an **attack-cost-per-basis-point** (the USDC an attacker must burn to move it 1bp). Headline resistance (`make demo`): naive VWAP dragged **+110.8%** vs ACR **+0.20%** = **562×** more resistant, while the attacker burned $147.60.

---

## 2. Project structure

Python **uv workspace** (`packages/*` + `services/*`) + Next.js Terminal + TS buyer agent + Foundry contracts.

```
packages/
  acr_core         Shared foundation: config.py (ACRSettings), types, indices, mathutils
  acr_sim          Calibrated simulator (default data source) — OU price, sellers, batching, adversary
  acr_tape         TapeSource abstraction: SimSource (default) · ArcSource (real Arc logs) · ReceiptSource (x402 ledger)
  acr_estimator    THE PRODUCT — pillars 1-3 (Kalman deconv · hedonic · bound) + the
                   unnumbered stages they rest on (cleaning/sybil · trimmed-median+CI)
  acr_oracle_client  Sign + publish on-chain (LocalKey / Circle custody signer), read Oracle + Registry
  acr_instrument   Pillar 4: ACRFuture (cash-settled) + Avellaneda–Stoikov MM  [168 LOC — smallest]
services/
  index_api        FastAPI x402-gated seller: store, x402 (Dev+Circle), marketplace, poster, onchain, webhooks
apps/
  agent            TS buyer agent (DevPayer / GatewayPayer, catalog, interop 12-field SDK check)
  terminal         Next.js 14 dashboard ("The Terminal") — 8 pages + 16 API routes
contracts/         Foundry (solc 0.8.24): ACROracle, AttestationRegistry, ACRFutures, FeedAccessAttestor + 60 tests
scripts/           eval (resistance gate), demo, gen_snapshot, deploy_circle, onchain_demo
redteam/           wash_attack.py, optimal_attack.py (proves the bound attainable)
docs/              this file + IMPLEMENTATION_STATUS, SUBMISSION, methodology, presentation (deck), runbooks
```

`Makefile` is the command hub (`make ci` = lint + tests + eval-gate, mirrors GitHub CI).

---

## 3. Completion scorecard

| Part | Completeness | Live? | What's left for production |
|---|---|---|---|
| Estimator (4 pillars) | **Complete, real** | Runs on sim + Arc tape | Cap-denominator refinement (nice-to-have) |
| Manipulation bound / red team | **Complete, CI-gated** | Yes | — |
| Contracts (Oracle + Registry + Futures + Attestor) | **Complete** (60 tests, 7 invariants) | **Deployed on Arc testnet** | Mainnet audit |
| Oracle signing (Circle custody) | **Complete** | **Live, hourly, in-cloud** | — |
| x402 payment gate (Dev + Circle) | **Complete** | **Live, real USDC settled** | Verify webhook header/pubkey path (FLAG) |
| Buyer agent + marketplace | **Complete** | **Proven end-to-end** | Await Circle Marketplace listing (form submitted 2026-08-04) |
| Tape / ArcSource | Real decode built | Sim is default (by design) | Verify real Arc event sig + service resolver (FLAG) |
| API service | **Complete + deployed** | **Live (Render free tier)** | Paid tier to kill cold starts |
| Terminal dashboard | **Complete + deployed** | **Live (Vercel)** | Next.js 15 upgrade (Dec-2025 advisory) |
| **Instrument layer (W6)** | **Complete** | **Live** — `ACRFutures` on Arc; readers trade it from their own Circle user-controlled wallets | Third-party market makers (the book is first-party today) |
| Paymaster / ERC-4337 | **Deferred by design** | N/A | Not needed — USDC *is* gas on Arc |

---

## 4. UI status — the Terminal (`apps/terminal`)

Next.js 14.2 App Router, React 18, SWR, hand-authored `globals.css` (~1,600 lines, no Tailwind), **all charts hand-rolled SVG** (no chart lib). **Verdict: a polished, coherent, genuinely differentiated MVP — not a scaffold. No stubs or placeholders.**

**Pages** (each = server `page.tsx` + client `view.tsx` + `loading.tsx`; nav in `Masthead.tsx`):

| Route | Nav | What it is | Maturity |
|---|---|---|---|
| `/` | Fixing | Home: 3 glass rate cards, defensibility strip, prints table | ✅ (getting the new hero — §8) |
| `/index/[id]` | — | Deepest page: big ticking rate, CI-ribbon history chart, full provenance + "how it defends itself" | ✅ **most impressive** |
| `/attack` | Attack Lab | Adversary-room palette flip; run a live wash-attack, watch VWAP explode vs ACR flat | ✅ **the money demo** |
| `/curve` | Curve | Avellaneda–Stoikov term structure (quote corridor + bid/mid/ask table) | ✅ (static corridor) |
| `/exchange` | Exchange | Marketplace catalog, settlement tape, wallet balances, **two real buyer paths** | ✅ (dense) |
| `/sellers` | Registry | On-chain attestation card + seller reliability table (sim/real honestly split) | ✅ |
| `/developers` | Developers | Interactive x402 console (dev + **real Circle settle**), revenue, webhooks, endpoints | ✅ **2nd strongest** |
| `/companion` | Companion / Start Here | Plain-English primer + glossary — the page written for a first-time reader (now in the nav, not just the footer) | ✅ |

**The standout subsystem = the honesty / connection-ladder system.** `lib/connection.ts` (unit-tested) derives a 6-state ladder — `live / stale / waking (cold start) / onchain-only / archived / linking` — surfaced as a breathing `StatusPill`, per-card `on-chain / direct / archived / sim` badges, `FinalityBadge` (ticking age vs static finality), and `TxLink` (real hash vs gateway-ref vs sim). Each surface trusts *its own* envelope's `live` flag and says exactly what it shows — never fakes freshness. **This is a real differentiator.**

**Design system — "Arc Dawn":** permanently-dark chain-native terminal; navy→gold "pre-dawn sky" surfaces; `--sand` is THE rate color; `--finality` teal = settled; glass panels + tinted glows; 4 fonts (Space Grotesk / DM Sans / Space Mono / IBM Plex Mono). Motion is CSS-first and fully `prefers-reduced-motion`-safe. **Currently ~70% utilitarian / 30% hooky** — the hooky bits (rolling ticker numbers, breathing pill, marquee tape, adversary-room flip) are excellent, but there was **no first-viewport "wow"** (the signature dawn/`ArcHorizon` asset was stranded in a 96px footer). §8 addresses this.

**Terminal tests:** 12 suites (buy plan · connection ladder · oracle codec · futures codec · edition · glossary · plain-edition coverage · desk phase · futures book · read result · chain constants · price formatting) on the security- and honesty-critical pure logic. Build config production-clean (`next.config.mjs` marks the Circle SDK external).

---

## 5. SIM vs REAL — what's simulated and why (the honest core)

**One-line truth:** the hero index `value` is a **real, complete estimator's output**, computed over a **calibrated *simulator's* synthetic tape**, then **EIP-712-signed and posted to a real testnet oracle**. The math is real; the chain plumbing is real; the *economic flow the number is computed from* is simulated **by design** — and the code is explicit about why.

| Payload field | Provenance |
|---|---|
| `value`, `ci_lo/hi`, `n_obs`, `attack_cost_per_bp` | **SIM tape → REAL estimator** (the hero number) |
| `naive_vwap`, `cost_to_move_1pct`, `cleaned_pct`, `vol`, `curve`, `sellers`, `attack` | **SIM-derived** (estimator diagnostics + A-S curve + wash exhibit) |
| `onchain` (per-index oracle read) | **REAL** — reads deployed ACROracle |
| `chain` block (ids, addresses, gate, signer, poster tx/block) | **REAL** Arc testnet facts + signed postPrint receipts |

**Why sim is the default (honest rationale, from the code's own docstrings):** real Arc / x402 flow is **flat-at-reference and single-seller** — the x402 `exact` scheme's on-chain event carries *no amount, size, or service*, so `ArcSource`/`ReceiptSource` deliberately derive `size` so `price == reference` and **fabricate no price dispersion**. That flat, single-seller flow is *precisely* the degenerate wash-like pattern the cleaning stack is built to reject → fed to the estimator it yields **zero surviving observations** (correct behavior). The rich, dispersed, adversary-containing **simulator is the only source that produces a meaningful published number**, so it stays the transparently-labeled `sim` default. The real sources stand ready as **audit tape** and drop-in replacements "the day priced, multi-seller settlement flow exists." *(This is the SOFR defense: methodology-first, liquidity-second.)*

**Measured, 2026-08-01 (`make tape-audit`).** That rationale is no longer only
an argument. Run against live Arc it reads **16,339 real USDC settlements over
20,000 blocks** — every one of them at the *same* price (the legacy decode
recovers notional and fabricates no price signal, exactly as designed), all
landing on a single index, with ACR-GPU and ACR-DATA seeing **zero** events. So
the published number could not come from real flow today even in principle. The
audit re-runs on demand, so the day priced multi-seller settlement exists the
claim gets re-checked rather than re-asserted.

**What is genuinely REAL:** the estimator (Louvain sybil cleaning, volume-time α-trimmed weighted median + bootstrap CI, Kalman deconvolution, WLS hedonic, closed-form cap-aware bound); the deployed contracts + reads/writes; EIP-712 postPrint via a Circle custody wallet; x402/Circle Gateway settlement (`exact`/GatewayWalletBatched, fail-closed); the durable settlement ledger; and Circle webhook (P-256) verification.

**Honesty tiers** (all truthfully applied): `sim` (SimSource / `sim-` refs) · `dev` (mock gate, `dev-N` refs) · `gateway-ref` (real Circle Gateway batch UUID) · `tx` (real on-chain hash) · `live` (real circle gate + funded Gateway buyer).

---

## 6. What's LIVE on testnet

- **Dashboard:** https://arc-compute-rate.vercel.app (Vercel) — 6-tier connection ladder; falls back to direct on-chain ACROracle reads when the API sleeps.
- **Seller API:** https://acr-api-1fto.onrender.com (Render free tier) — circle gate, hourly in-cloud postPrint via Circle custody, keepalive cron.
- **ACROracle** `0x4f00e3BDd224F4c4b4958D54cD774E84B9092609` · **AttestationRegistry** `0x23ae3E1A306824F0CBA0b6561cB7E5502f63dFb7` (4 real attestations) · **ACRFutures** `0x29d97c629a8278f7ec4218ab0bd8baa9182642fe` (three cash-settled books, traded hourly) · **FeedAccessAttestor** `0xe671a8E73900F1186448cFFeA9e730F5E50DFD47` (off-chain x402 payments made checkable on-chain) — explorer `testnet.arcscan.app`.
- **Proven x402 settlement:** buyer `0x870f…` paid the gated endpoints — real USDC moved (Gateway balance 0.500000 → 0.494000, `pendingBatch: 0`); refs are Gateway batch UUIDs (GatewayWalletBatched).

---

## 7. What's LEFT — prioritized

**MVP-blockers:** none critical. The core loop is live and proven.

**Production-hardening (the real remaining work):**
1. **Cloud cold-start** — the Render 512MB free tier spins down; mitigated by a keepalive cron + post-on-wake + the connection ladder (not a correctness issue). *Kill it fully with a paid tier (Render Starter ~$7/mo) or 1GB instance.*
2. **`.env` hygiene** — the repo `.env` now holds the real operator credentials (it is what drives every live transaction); the discipline is keeping it out of CI and images (`conftest.py` disables it for tests; secrets never reach GitHub Actions — the entity secret controls every custody wallet including the oracle signer).
3. **Three unverified FLAGs** (confirm at first live use against the live SDK/chain):
   - `services/index_api/index_api/webhooks.py:33` — exact Circle webhook header names + public-key path.
   - `scripts/deploy_circle.py:134,138` — Circle SCP SDK `deploy_contract`/`import_contract` request shapes.
   - `ArcSource` — real Arc event signature + `size`/`service` derivation (currently a reference-level resolver by design).
4. **Next.js 15 upgrade** — Terminal pinned at 14.2.x; upgrade to clear a Dec-2025 advisory before a fully public production launch.

**Adoption / backlog:**
5. Circle **Agent Marketplace** directory: form **submitted 2026-08-04** ([`MARKETPLACE-LISTING.md`](../MARKETPLACE-LISTING.md)); awaiting Circle's response — the Discovery API still returns zero listings for `eip155:5042002`, so we claim *submitted*, not *listed*.
6. Cap-denominator methodology refinement (cap as fraction of surviving vs raw volume).

**The instrument layer (W6) — live-traded since 2026-07-31:** `acr_instrument` began as a *complete, correct model* (cash-settled `ACRFuture` + textbook Avellaneda–Stoikov MM, 168 LOC, tested) whose quotes were only computed and displayed (`/curve`). Today `ACRFutures` (`0x29d9…42fe`) runs **three live books** — ACR-INF, ACR-GPU and ACR-DATA, 10× multiplier each — cash-settling against the oracle print. A keeper on the trusted host rotates an hourly fill across whichever indices actually have a live series, an autonomous agent buys the print over x402 and trades on what it read, and any reader can take the other side from a Circle user-controlled wallet. What remains aspirational is **third-party** market makers: the maker on every book is still first-party.

**Update 2026-08-01:** the desk is no longer read-only. The **Public Desk** lets any reader open a Circle *user-controlled* wallet (SCA on Arc, PIN-secured in Circle's hosted UI) and run the whole lifecycle — faucet stake → `approve` → `postCollateral` → `trade` → `withdrawCollateral` — with settlement and series rolls automated. So the counterparties are now genuinely external *humans*, even though the **maker** on the other side of every fill is still our own bot and the stake is our grant; the UI says so. Verified on Arc with four independent witnesses per action, including a withdrawal that moved 0.50 USDC back out of the venue.

**Deferred by design:** ERC-4337 Paymaster / gasless — intentionally out; Arc USDC *is* the native gas token, so gasless UX is intrinsic.

---

## 8. Roadmap (7-week hackathon) & the funky-UI hook

**Roadmap** (from `docs/ARCHITECTURE-DIAGRAM.md` §Zone I / `SUBMISSION.md`): **W1 TAPE ✅ · W2 ESTIMATOR ✅ · W3 ON-CHAIN ✅ · W4 ADOPTION ★ ✅ · W5 RED TEAM ✅ · W6 INSTRUMENT ✅ live on-chain (`ACRFutures` `0x29d9…42fe`, three books traded hourly) · W7 SHIP ✅ shipped** (repo pushed, CI green, cloud hardened + posting re-enabled, deck re-rendered 2026-08-04).

**Funky-UI hook — shipped:** the first-viewport moment exists now. `/` opens on a full-viewport landing hero (`HomeHero`) — the signature `--dawn-full` gradient + rising-sun/arc SVG, a **giant live-ticking flagship rate** (ACR-INF, honestly badged live/on-chain/archived), the tagline, the **562× resistance stat**, and a "Watch the attack →" CTA. Fully reduced-motion-safe; the other pages kept their editorial grid.

---

## 9. Tests & CI

- **Python: 445 tests** (incl. anvil-gated on-chain integration, skipped when anvil is down — CI boots a node so they genuinely run) — core, estimator, instrument, oracle_client, sim, tape, services (x402-circle, marketplace, webhooks, terminal-bundle, keeper, desk), top-level `tests/`.
- **Foundry: 60 tests** (17 ACROracle + 10 AttestationRegistry + 16 ACRFutures + 10 FeedAccessAttestor + 5 + 2 invariant, `fail_on_revert=true`).
- **Node: 105 tests** (95 terminal + 10 agent) + `tsc` type-checks.
- **Gates:** ruff clean · glossary 426/426 · resistance eval-gate 4/4 · interop 12/12.
- **CI** (`.github/workflows/ci.yml`, 4 jobs, every push/PR): python (ruff+pytest+eval-gate) · contracts (forge) · agent (build+test) · terminal (test + `next build`). Plus `keepalive.yml` (cron pings the API `/health`). Hermetic — `conftest.py` disables `.env` + strips `ACR_*`, so `make ci` needs no secrets.

**Repo:** `github.com/kaustubh76/ACR---Arc-Compute-Rate`, branch `main`, fully pushed, CI green. (No commit count stated here on purpose: it drifts daily and nothing gates it — `git rev-list --count main` is the measurement.)
