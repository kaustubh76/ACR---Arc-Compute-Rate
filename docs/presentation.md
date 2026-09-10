---
marp: true
title: ACR — Arc Compute Rate · Submission
description: Arc/Circle 7-week hackathon · Agentic Economy track · final submission (2026-07-31)
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
  section.light h2 { color: #16233a; }
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
footer: "ACR · ARC COMPUTE RATE · SHIP WEEK · 2026-07-31"
---

<!-- _class: lead -->
<!-- _paginate: false -->
<!-- _footer: "" -->

###### ARC / CIRCLE 7-WEEK HACKATHON · AGENTIC ECONOMY TRACK · FINAL SUBMISSION

# ACR — the Arc Compute Rate

## Machine commerce just got its **SOFR** — and it prints its own **attack cost**.

A manipulation-resistant reference rate for machine services, live on Arc testnet — and the cash-settled futures venue that trades on it.

`arc-compute-rate.vercel.app` · `github.com/kaustubh76/ACR---Arc-Compute-Rate`

<!-- Open cold: every financial market runs on a reference rate. Machine commerce — agents buying inference, GPU time, bandwidth — has none. We built it, it's printing on-chain right now, and by slide 3 you'll meet its first customer. -->

---

###### THE PROBLEM

# Agents trade machine services with **no trustworthy price**

- Agents already pay per call for inference, GPU time, and data — but there is **no benchmark** to settle contracts against or hedge with.
- The raw payment exhaust is **noisy, batched, and adversarial**.
- A naive volume-weighted average is an open invitation: our own red team moves it <span class="bad">+122%</span> with wash trades.

> No benchmark means no hedging, no term markets, no credit. Machine commerce is stuck at spot.

<!-- Key beat: this is benchmark construction, not a dashboard. Everything downstream depends on the print being manipulation-resistant. And the next slide is who pays for that gap. -->

---

###### THE USE CASE · WHO NEEDS THIS NUMBER

# Meet the hedger: an agent business with a floating USDC burn

- **Portia**, an autonomous paralegal fleet, resells LLM work at fixed prices but pays for inference per call — ~**100M tokens/mo × 0.49236 $/1k tokens** (the ACR-INF print) ≈ **$49,236/mo**, all floating. One +10% month is **+$4,924** of unbudgeted burn.
- The fix: go **long ACR-INF futures**. Cash-settled — at expiry the venue **freezes the freshest oracle print** (≤ 2 h old, enforced on-chain) and pays the difference in USDC. **No delivery, no GPU repossession, no seller cooperation.**
- A hedge is only as good as its settlement print: every ACR print ships its **CI** and its **attack-cost-per-bp**, so both sides can read — on-chain — what bending the settle would cost.
- **This loop is live on Arc testnet:** `ACRFutures 0x29d97c62…82642fe` — **three books** (ACR-INF, ACR-GPU, ACR-DATA), 10× multiplier, 2000 bp initial margin on this deployment, socialized-loss clearing, settling against the same ACROracle.
- **And an agent already runs Portia's playbook.** It pays $0.0001 for the print over x402, reads its own book, and trades the gap to its mandate — from a Circle agent wallet, unattended. **It pays for the print, and the venue fills it at that same print — so the position it holds is the print it bought, and that join is enforced by the contract, not claimed by the agent.** That is the whole product in one sentence; the next slide is the cast that surrounds it.

<!-- Every compute future before this died one of two deaths: physical delivery you can't enforce, or cash settlement against an index you can bend. We amputated delivery — "capacity forwards with the hardest organ amputated" — and made bending priced. Portia's math is a worked example at the ship-week print; the venue is testnet-scale by design (10× multiplier). The mechanism, not the notional, is the product. -->

---

###### THE ECONOMY · SIX WALLETS, SIX MANDATES

# Every Circle wallet model, doing a job — not ticking a box

| Agent | Wallet | Pays for | Decides |
|---|---|---|---|
| **press** | Developer-Controlled | gas to sign 3 prints/hr | **nothing, deliberately** |
| **maker · taker** | Developer-Controlled ×2 | collateral, roll gas, hourly fill | size, against both sides' margin |
| **hedger** | **Agent wallet** (SCA trades, EOA pays) | the print, then its own margin | *everything* — and refuses rather than clamps |
| **reader** | **User-controlled** SCA, PIN | nothing: Gas Station sponsors | their own trade, their own exit |
| **CLI buyer** | raw EOA + `x402-batching` | $0.0001 × 13 resources | which listings to buy |

**We consume Circle's Skills and publish one back** (`skills/acr-hedge`), and `make gateway-deposit` (Unified Balance Kit) makes the last operator step something an agent does for itself.

<!-- This slide replaced a five-row compliance table. Same coverage, told as a product: Nanopayments is the hedger's receipt, Agent Wallets is three rows here, Marketplace is what the CLI buyer shops. The honest line to say out loud: both sides of the book are ours, and both payers are ours. The mechanism is real; the demand is not yet. -->

---

###### THE PRODUCT

# Three indices, live on Arc testnet — chain `5042002`

| Index | Measures | Latest on-chain value |
|---|---|---|
| **ACR-INF** | Inference — $/1k tokens | **0.49236** |
| **ACR-GPU** | GPU compute — $/GPU-sec | **0.01110** |
| **ACR-DATA** | Data egress — $/MB | **0.00209** |

Every hourly print ships **three numbers**: the rate, a confidence interval, and the **attack-cost-per-bp** (ACR-INF ≈ **0.0094 USDC/bp**).

Read live from ACROracle at final submission — posted **hourly, in-cloud, signed by a Circle custody wallet** — and now the print the **futures venue freezes at expiry**.

<!-- LIVE PATH: skim unless asked. The attack-cost-per-bp is the differentiator: the index quantifies its own manipulation cost on every print. The previous slide's hedge settles on exactly these numbers. -->

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

**And the bridge nobody else has to build:** Gateway settles nanopayments *off*-chain, so "this wallet paid for the feed" normally lives only in a seller's ledger. `FeedAccessAttestor` signs that receipt with the same custody wallet that signs prints, so **an off-chain payment becomes an on-chain right** — which is what lets a venue rebate fees to the wallets that paid for its index.

<!-- The kill-question "why Arc?" answered mathematically: on a probabilistic-fee chain, attack cost is a Monte Carlo estimate. On Arc it's arithmetic. -->

---

<!-- _class: light -->
<!-- _footer: "" -->
<!-- _paginate: false -->

###### ARCHITECTURE · ONE PIPELINE

## Adversarial exhaust in → settleable print out

![w:1000](assets/acr_architecture.core.svg)

*Tape → clean (wash · sybil) → deconvolve (Kalman/RTS) → α-trim median + hedonic → print + CI + attack-cost → EIP-712 oracle → futures settle → agents buy the rate back via x402.*

<!-- LIVE PATH: skip unless asked — the caption carries the pipeline for PDF readers. Generated deterministically by scripts/gen_architecture.py. -->

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

<!-- LIVE PATH: skim unless asked. One analogy per pillar: deblurring a photo; a funding-graph spam filter; Case-Shiller for compute; a published price-of-corruption. -->

---

###### LIVE ON ARC · ALL GATES RE-RUN 2026-09-07

# Deployed, printing, hedgeable — all seven weeks shipped

| Contract / surface | Live proof |
|---|---|
| **ACROracle** `0x4f00e3BD…9092609` | Hourly EIP-712 prints, Circle custody signer |
| **AttestationRegistry** `0x23ae3E1A…2f63dFb7` | 4 seller attestations on-chain |
| **ACRFutures** `0x29d97c62…82642fe` | Three live books (INF/GPU/DATA), **maker is a Circle custody wallet**, cash-settles on the print |
| **Terminal + Seller API** | API x402-gated at **$0.0001/query**, fail-closed |

`make ci` green 2026-09-10: **565 py** · **156 forge** (incl. futures + invariants) · **123 terminal** · **13/13 agent** · resistance **4/4** · interop **12/12** · glossary **426/426** · GitHub CI **6/6**.

Real settlement through **Circle Gateway** — batch-UUID receipts in-repo and on the public `/exchange` tape; Circle's own CLI paid the gate (`payable`).

Provenance labeled on every value — `sim` / `gateway-ref` / `tx`. Reproduce: `make setup && make ci && make demo`.

<!-- LIVE PATH: skim — one breath on addresses, then: three make commands reproduce every claim. The honesty tiers earn trust: sim is labeled sim, and flat query fees are never laundered into the index as prices. -->

---

###### THE LIVE DEMO · 3 MINUTES

# Attack the index, then hedge on it

1. `/` — the print ticking live: rate + CI + attack cost. New to the jargon? Flip the masthead to **plain** — the whole paper re-sets in plain English.
2. `/attack` — press the button: wash flow floods in, naive VWAP swings <span class="bad">~+110%</span>, **ACR holds**, and the counter burns the attacker's USDC. Offline twin: `make demo` — one command, ~1 minute.
3. `/curve` — the term structure, the **live futures desk** read from ACRFutures on-chain, and **the Public Desk: trade it yourself.** Open a Circle *user-controlled* wallet in the browser (your PIN, our gas), take the stake, place a real fill, withdraw it again — the key never leaves your device, so every step is a challenge only your PIN can sign.
4. `/exchange` — **the hedger, both legs in one card, which is what this slide's title promised.** *1 · prints it bought*: real **Circle Gateway batch UUIDs**, $0.0001 each, settled by the agent's own wallet — a settlement reference, not a hash, because Gateway batches off-chain. Then the joint: the venue fills every trade at that same print, so the card prints the arithmetic live — **`2.47 × 0.49236 × 10 = 12.16 USDC`** was the position those prints bought when this slide was cut. *2 · fills it took* is the on-chain half. An agent at its mandate stops trading, so when its fills have aged out of the tape's ~8 h reach the table says exactly that rather than pretending. Real Gateway settlements on the marketplace tape below; paper trail in `docs/SUBMISSION.md`.

**Live:** https://arc-compute-rate.vercel.app · reader's companion at `/companion`

<!-- LIVE PATH: this is the cutaway. Demo prep: hit /health five minutes early (free-tier press wakes in ~60 s); if still cold, the Terminal labels the tier honestly and reads ACROracle directly — even the fallback is on-chain truth. make demo needs no network. Series rolls are automated (futures-lifecycle.yml); `make desk-preflight` confirms the venue is tradable before a session. The Public Desk needs a PIN ceremony per action, so allow ~30 s per step live. The hedger card is the beat that answers "so what": say out loud that its two tables are two different KINDS of evidence — one off-chain settlement reference, one on-chain transaction — and that the sentence between them is the contract's rule rather than our claim. The mark moves, so read whatever figure is on screen rather than the one on this slide. If the fills table is empty, that is the expected state for an agent already at its mandate and the card says so itself. There is no round-trip to run: `circle wallet execute` cannot build a transaction carrying a negative int256, so the agent can raise a position and never lower one. `docs/SHIP-CHECKLIST.md` ("Putting a fresh fill on the hedger panel") says to raise the mandate by at least MIN_TRADE and leave it raised — a decision to take BEFORE the recording, not during it, because you cannot take it back. -->

---

###### THE LIFECYCLE · WHAT HAPPENS AFTER THE DEADLINE

# Arc mainnet is **September 16**. This is day-one infrastructure.

- **Nothing here is a testnet exhibit.** The estimator, the oracle, the venue and the gate are chain-first; the only Arc-specific assumptions are the ones that make the manipulation bound *a number at all* — deterministic USDC fees, USDC as gas, sub-second finality.
- **The one thing we are missing, named:** a dependent that is not us. The venue settling on the feed is a real dependent — but we deployed both. One outside consumer turns *"our two components agree"* into *"someone else is exposed to this number."* The Marketplace listing is submitted; Circle's Discovery API carries no Arc network yet.
- **And a community, with something to hold.** Post-hackathon: **$GPOOR** on **ACTFUN**, Arc's own community-mined launchpad — you mine it by complaining about compute prices on-chain, with the live ACR print in the complaint. It belongs *after* a submission, not inside one: the mining window is an hour, and a launch nobody can mine is not a fair launch.

## **Stop whining. Hedge.**

<!-- Deliberately not built for the deadline: the token was analysed and cut. It scores zero on an agentic-economy rubric, and a meme launch would have eaten the day that bought the App Kits integration and the published skill. Saying which quirky idea we killed, and why, is worth more than shipping it. -->

---

<!-- _paginate: false -->
<!-- _footer: "" -->

###### WHY THIS WINS

# The rate machine commerce settles on

- **Judge fit:** ICE — a benchmark administrator — is on Arc's testnet roster; Apollo, BNY, Mastercard are rate-native.
- **The neutrality moat:** Circle can't own the benchmark (the LIBOR lesson) — ACR is a partner, not a feature.
- **The loop closes:** resistant print → on-chain oracle → **cash-settled futures** + x402-paying machine customers → attestations → a better print.
- The first machine-commerce benchmark with a **live derivative venue** — three books, a term structure, and agents on both sides of it.

**Terminal** `arc-compute-rate.vercel.app` · **API** `acr-api-1fto.onrender.com`
**Contracts** `0x4f00e3BD…` / `0x23ae3E1A…` / `0x29d97c62…` on `testnet.arcscan.app` · `docs/SUBMISSION.md`

<!-- Close on the tagline: "Machine commerce just got its SOFR — and it prints its own attack cost." Live path: 1 → 2 → 3 → 5 → 6 → demo → here. -->
