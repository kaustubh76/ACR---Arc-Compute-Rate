---
marp: true
title: ACR — Arc Compute Rate · Midway Submission
description: Arc/Circle 7-week hackathon · Agentic Economy track · halfway checkpoint (2026-07-27)
size: 16:9
paginate: true
style: |
  /* ---- "Arc Dawn" — tokens lifted from apps/terminal/app/globals.css ---- */
  :root {
    --genesis: #000b24; --ledger: #0b223e; --protocol: #1b3158;
    --validator: #2f578c; --ether: #d5e0e7; --sky: #acc6e9;
    --sand: #ffcc6f; --gold: #e9a13f; --breach: #ef6a5a; --finality: #4fb3a9;
    --hairline: rgba(172, 198, 233, 0.18);
  }
  section {
    background: var(--genesis);
    color: var(--ether);
    font-family: "Avenir Next", "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 25px;
    line-height: 1.45;
    padding: 58px 72px;
    justify-content: flex-start;
  }
  /* the full dawn gradient appears exactly once — the title slide */
  section.lead {
    background: linear-gradient(180deg, #000b24, #052950 68%, #416d91 140%);
    justify-content: center;
  }
  section.light { background: #f7f5f0; color: #16233a; }
  section.light h6 { color: #a06915; }
  section.light em { color: #41537a; }
  h1 { font-size: 1.7em; letter-spacing: -0.015em; color: var(--ether); }
  h2 { font-size: 1.25em; color: var(--ether); margin-top: 0.1em; }
  /* h6 = eyebrow line */
  h6 {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.58em; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.35em; color: var(--gold); margin-bottom: 0.4em;
  }
  strong { color: var(--sand); font-weight: 700; }
  em { color: var(--sky); font-style: normal; }
  a { color: var(--sky); }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    background: rgba(27, 49, 88, 0.75); color: var(--sand);
    padding: 0.08em 0.32em; border-radius: 4px; font-size: 0.86em;
  }
  blockquote {
    border-left: 3px solid var(--gold); color: var(--sky);
    padding-left: 0.8em; margin-top: 0.6em;
  }
  table { font-size: 0.86em; border-collapse: collapse; margin-top: 0.4em; }
  th {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--sky); background: var(--ledger);
    border: 1px solid var(--hairline); padding: 0.45em 0.8em;
  }
  td { border: 1px solid var(--hairline); padding: 0.42em 0.8em; background: #0d2136; color: var(--ether); }
  section.light th { color: #41537a; background: rgba(22,35,58,0.06); border-color: rgba(22,35,58,0.18); }
  section.light td { background: #f7f5f0; color: #16233a; border-color: rgba(22,35,58,0.18); }
  .bad { color: var(--breach); font-weight: 700; }
  .ok { color: var(--finality); font-weight: 700; }
  footer, section::after {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px; letter-spacing: 0.15em; color: rgba(172, 198, 233, 0.55);
  }
footer: "ACR · ARC COMPUTE RATE · MIDWAY CHECKPOINT · 2026-07-27"
---

<!-- _class: lead -->
<!-- _paginate: false -->
<!-- _footer: "" -->

###### ARC / CIRCLE 7-WEEK HACKATHON · AGENTIC ECONOMY TRACK · MIDWAY CHECKPOINT

# ACR — the Arc Compute Rate

## Machine commerce just got its **SOFR** — and it prints its own **attack cost**.

A manipulation-resistant reference rate for machine services, live on Arc testnet.

`terminal-gules-eta.vercel.app` · `github.com/kaustubh76/ACR---Arc-Compute-Rate`

<!-- Open cold: every financial market runs on a reference rate. Machine commerce — agents buying inference, GPU time, bandwidth — has none. We built it, and it's printing on-chain right now. -->

---

###### THE PROBLEM

# Agents trade machine services with **no trustworthy price**

- Agents already pay per call for inference, GPU time, and data — but there is **no benchmark** to settle contracts against or hedge with.
- The raw payment exhaust is **noisy, batched, and adversarial**.
- A naive volume-weighted average is an open invitation: our own red team moves it <span class="bad">+122%</span> with wash trades.

<!-- Key beat: this is benchmark construction, not a dashboard. Everything downstream depends on the print being manipulation-resistant. -->

---

###### THE PRODUCT

# Three indices, live on Arc testnet — chain `5042002`

| Index | Measures | Latest on-chain value |
|---|---|---|
| **ACR-INF** | Inference — $/1k tokens | **0.50271** |
| **ACR-GPU** | GPU compute — $/GPU-sec | **0.01227** |
| **ACR-DATA** | Data egress — $/MB | **0.00200** |

Every hourly print ships **three numbers**: the rate, a confidence interval, and the **attack-cost-per-bp** (ACR-INF ≈ **0.0146 USDC/bp**).

Read live from the oracle at checkpoint time via `make verify-testnet`.

<!-- The attack-cost-per-bp is the differentiator: the index quantifies its own manipulation cost on every print. -->

---

###### THE HEADLINE RESULT

# $8,000 wash attack. The attacker got **≤ 2.39%**.

| Index | naive VWAP moved | ACR moved | Resistance |
|---|---|---|---|
| ACR-INF | <span class="bad">+110.8%</span> | <span class="ok">+0.20%</span> | **562×** |
| ACR-GPU | <span class="bad">+107.1%</span> | <span class="ok">−1.02%</span> | **105×** |
| ACR-DATA | <span class="bad">+122.5%</span> | <span class="ok">+2.39%</span> | **51×** |

36,000 adversarial authorizations; the attacker burned **$147.60** in fees. Claims are **CI-gated** (`make eval-gate`) so they cannot silently drift.

<!-- Run `make demo` live if there's time — one command, about a minute, prints this table. 12-hour series: 46× (VWAP 5703.9 bp vs ACR 124.1 bp attack-window error). -->

---

###### WHY ONLY ON ARC

# Six **mathematical** dependencies — not deployment conveniences

| Arc property | What it buys the estimator |
|---|---|
| Malachite deterministic finality | Clean tick timestamps |
| Gateway: one canonical rail | Complete observation, no selection bias |
| x402 nanopayments | Agents are the index's *paying customers* |
| USDC numeraire | No gas-token deflator in the signal |
| **Deterministic USDC fees** | The attack cost is **a number, not a distribution** |
| Agent Marketplace | Native machine-to-machine discovery |

<!-- The kill-question "why Arc?" answered mathematically: on a probabilistic-fee chain, attack cost is a Monte Carlo estimate. On Arc it's arithmetic. -->

---

<!-- _class: light -->
<!-- _footer: "" -->
<!-- _paginate: false -->

###### ARCHITECTURE · ESTIMATOR CORE → SETTLEMENT-GRADE ORACLE

![w:1180](assets/acr_architecture.core.svg)

<!-- Tape indexer → observation model → cleaning → robust estimator → hedonic + cost bound → hourly prints → EIP-712 oracle + attestation registry. Generated deterministically by scripts/gen_architecture.py. -->

---

###### METHODOLOGY · FOUR PILLARS, ONE ESTIMAND

# Recovering the latent constant-quality price

| Pillar | What it does |
|---|---|
| **Observation model** | Kalman + RTS smoother deconvolves Gateway's settlement batching |
| **Cleaning** | 4 funding-graph defenses (self-deals, wash cycles, sybil clusters, caps) — ~100% of injected wash zeroed |
| **Robust core + hedonic** | Trimmed volume-weighted median (breakdown point ½) + bootstrap CI; quality-adjusted via on-chain seller attestations |
| **Manipulation bound** | Prices the cheapest surviving attack per bp — validated *attainable* by `redteam/optimal_attack.py` |

Full spec: `docs/methodology.md` — published before liquidity, the way SOFR was.

<!-- One analogy per pillar if asked: deblurring a photo; a funding-graph spam filter; Case-Shiller for compute; a published price-of-corruption. -->

---

###### LIVE ON ARC · REAL USDC MOVED

# Deployed, printing, and **already selling itself**

- **ACROracle** `0x4f00e3BD…9092609` — hourly EIP-712-signed prints; signed via raw key or a **Circle Developer-Controlled Wallet**.
- **AttestationRegistry** `0x23ae3E1A…2f63dFb7` — 4 real seller attestations.
- **Proven x402 settlement:** a machine buyer paid the Circle-gated API — **60 queries · 0.006 USDC**, Gateway balance **0.500000 → 0.494000**, settled in Gateway batches.
- All **5 Circle Agent Stack pillars** mapped to code; interop **12/12** against Circle's own `GatewayClient`.

<!-- Honest framing: settlement refs are Gateway batch UUIDs, not "60 L1 transactions." The index about machine commerce is bought by machines — $0.0001/query. -->

---

###### VERIFICATION · ALL RE-RUN 2026-07-27

# Nine gates, **all green**

| Gate | Result | Gate | Result |
|---|---|---|---|
| Python suite | <span class="ok">163 pass · 2 skip</span> | Terminal build | <span class="ok">clean</span> |
| Foundry | <span class="ok">32/32 + 5 invariants</span> | Buyer agent | <span class="ok">10/10</span> |
| Resistance gate | <span class="ok">4/4</span> | Interop | <span class="ok">12/12</span> |
| Lint + glossary | <span class="ok">clean · 332/332</span> | On-chain read | <span class="ok">3 live prints</span> |

Every value labels its provenance — `sim` / `gateway-ref` / `tx` — in the data **and** in the Terminal UI. Reproduce: `make setup && make ci && make demo`.

<!-- The honesty tiers earn trust: sim is labeled sim, and flat query fees are never laundered into the index as prices. -->

---

###### ROADMAP · WEEK 3.5 OF 7

# Six of seven weeks of scope **already built**

| W1 TAPE | W2 ESTIMATOR | W3 ON-CHAIN | W4 ADOPTION ★ | W5 RED TEAM | W6 INSTRUMENT | W7 SHIP |
|---|---|---|---|---|---|---|
| <span class="ok">✅</span> | <span class="ok">✅</span> | <span class="ok">✅</span> | <span class="ok">✅</span> | <span class="ok">✅</span> | <span class="ok">✅</span> | ⏳ |

- Remaining: freeze + polish, one full credentialed Arc round trip, Circle Agent Marketplace directory submission.
- **Live demo:** `make demo` in the CLI, or the Terminal's `/attack` (wash the index in the browser) and `/exchange` (real x402 round-trips).

<!-- "Ahead of schedule at the halfway mark" is the takeaway. W6 = cash-settled ACRFuture + Avellaneda–Stoikov market maker — the index already has a term structure. -->

---

<!-- _paginate: false -->
<!-- _footer: "" -->

###### WHY THIS WINS

# The rate machine commerce settles on

- **Judge fit:** ICE — a benchmark administrator — is on Arc's testnet roster; Apollo, BNY, Mastercard are rate-native.
- **The neutrality moat:** Circle can't own the benchmark (the LIBOR lesson) — ACR is a partner, not a feature.
- **The loop closes:** resistant print → on-chain oracle → x402-paying machine customers → attestations → a better print.

**Terminal** `terminal-gules-eta.vercel.app` · **API** `acr-api-1fto.onrender.com`
**Contracts** `0x4f00e3BD…` / `0x23ae3E1A…` on `testnet.arcscan.app` · `docs/SUBMISSION.md`

<!-- Close on the tagline: "Machine commerce just got its SOFR — and it prints its own attack cost." -->
