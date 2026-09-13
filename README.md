# ACR — The Arc Compute Rate

[![ci](https://github.com/kaustubh76/ACR---Arc-Compute-Rate/actions/workflows/ci.yml/badge.svg)](https://github.com/kaustubh76/ACR---Arc-Compute-Rate/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![chain: Arc testnet 5042002](https://img.shields.io/badge/chain-Arc%20testnet%205042002-0c8599)](https://testnet.arcscan.app)
[![terminal: live](https://img.shields.io/badge/terminal-live-2f9e44)](https://arc-compute-rate.vercel.app)
[![Python 3.11](https://img.shields.io/badge/python-3.11-3776ab)](pyproject.toml)
[![Solidity 0.8.24](https://img.shields.io/badge/solidity-0.8.24-363636)](contracts/foundry.toml)

> **A live, on-chain reference rate for machine compute.**
> *"Machine commerce just got its SOFR — and it prints its own attack cost."*

Built for the **Arc / Circle 7-week hackathon (Agentic Economy)**, and continued for
**ETHOnline 2026 as a Continuity project** — baseline `v1.0-submission`, every change since
documented in [`CONTINUITY.md`](CONTINUITY.md). Submitted to three partner tracks, each with
something a judge can run: [**Arc**](#arc--both-continuity-bounties) (both continuity bounties
named below), [**The Graph**](#the-graph--best-ai-use-case-continuity) and
[**World**](#world--agentkit-continuity).

---

## What this is

Every agent-to-agent payment on [Arc](https://www.circle.com/arc) leaves a trace. The obvious move is to average those traces into a price. That produces a bad number, for three reasons this project takes seriously:

1. **Payments arrive batched.** Circle Gateway settles later than economic time, so the observed tape is the latent price *convolved with the batch scheduler*. A naive VWAP measures the scheduler, not the market.
2. **Sellers are not comparable.** A frontier model second and a small model second are not the same good. Averaging them measures the mix, not the price.
3. **The tape can be poisoned.** Wash trades and sybil seller clusters are cheap, and any index that matters will be attacked.

ACR treats the tape as a **noisy, batched, adversarial observation of a latent economic process** and builds the estimator that recovers it: a state-space deconvolution of the batching operator, a sybil/wash cleaning stage, an α-trimmed volume-weighted median, and a hedonic (Case-Shiller style) regression that strips seller-quality effects to leave a **constant-quality** rate.

It publishes three hourly indices — **ACR-INF** ($/1k tokens), **ACR-GPU** ($/GPU-sec), **ACR-DATA** ($/MB) — each with a confidence interval **and an attack-cost-per-bp**: the USDC an attacker must burn to move the print one basis point. That last number is only a *number* on Arc, where USDC fees are deterministic; on a volatile-gas chain it is a random variable.

Those prints are EIP-712-signed by a Circle custody wallet, posted on-chain to `ACROracle`, settled against by a cash-settled `ACRFutures` venue, and **sold back to agents** for $0.0001/query behind an x402 nanopayment gate. An autonomous hedger agent closes the loop: it pays for the print, reads it, and trades on it — with no human in the path.

**Why a benchmark at all:** every economy gets a spot market first and a reference rate second. Nothing above spot — hedging, credit, term structure — exists without one. Circle built the spot rails; ACR is the rate layer. And the administrator of a rate cannot be the operator of the rail (the LIBOR lesson), which is exactly why this is not a Circle product.

---

## Live right now

Arc testnet, chain `5042002`:

| | |
|---|---|
| **Terminal (dashboard)** | https://arc-compute-rate.vercel.app |
| **Seller API (x402-gated)** | https://acr-api-1fto.onrender.com |
| **Judge-facing status** | [`docs/SUBMISSION.md`](docs/SUBMISSION.md) |

| Contract | Address |
|---|---|
| `ACROracle` | [`0x4f00…2609`](https://testnet.arcscan.app/address/0x4f00e3BDd224F4c4b4958D54cD774E84B9092609) |
| `AttestationRegistry` | [`0x23ae…dFb7`](https://testnet.arcscan.app/address/0x23ae3E1A306824F0CBA0b6561cB7E5502f63dFb7) |
| `ACRFutures` (self-rolling) | [`0x29d9…42fe`](https://testnet.arcscan.app/address/0x29d97c629a8278f7ec4218ab0bd8baa9182642fe) |
| `FeedAccessAttestor` | [`0xe671…FD47`](https://testnet.arcscan.app/address/0xe671a8E73900F1186448cFFeA9e730F5E50DFD47) |
| `ACROracleV2` (policy hash + human-denominated bound) | [`0xFCa0…FFEA`](https://testnet.arcscan.app/address/0xFCa038CEad7b9e9aa8fDAfc9e80253835fB8FFEA) |
| `ReceiptMirror` (every x402 settlement, on chain) | [`0xA9CD…DB65`](https://testnet.arcscan.app/address/0xA9CD5b9503aeA88EB343333E842D2860b263DB65) |
| `HumanIdMirror` (which wallets are one person, per week) | [`0x7f41…d8e5`](https://testnet.arcscan.app/address/0x7f41faA38F35F1FABfc76Df5B1618fC8d0c0d8e5) |

**Mainnet:** Arc public mainnet (`eip155:5042`) opens 2026-09-16. ACR is **deployment-ready,
not deployed**: the same five Foundry scripts, in order, with a chain-id preflight —
`make deploy-mainnet-dry` simulates all of them today ([`docs/MAINNET_RUNBOOK.md`](docs/MAINNET_RUNBOOK.md)).
The first mainnet transaction hash will be added here the day it lands.

Check it yourself:

```bash
curl -s https://acr-api-1fto.onrender.com/health
curl -s https://acr-api-1fto.onrender.com/onchain/ACR-INF   # the settlement-grade on-chain print
```

---

## The three tracks, and what to run for each

### Arc — both continuity bounties

Submitted for **Launch on Arc Testnet & Push to Mainnet (Continuity)** *and* **Best DeFi or
Agentic Application (Continuity)** — named here because the prize text asks to be clear which.

- **Live on Arc testnet since July; mainnet-ready** (table above; `make deploy-mainnet-dry`).
- **An agent with decision logic tied to a real signal, spending USDC autonomously.** The buyer
  agent reads *its own* transaction costs from the tape The Graph indexes and moves its next
  Circle Gateway nanopayment to the seller it overpaid least:
  ```bash
  cd apps/agent && npm run start -- --live --count 3 --limit 0.02 --discover --reroute \
    --api https://acr-api-1fto.onrender.com      # AGENT_PRIVATE_KEY = a funded EOA
  # reroute: 0xa1c8…fca4 → 0xefe0…df19 — past fills say 2893 bp cheaper; next payment goes to /compute/acr-seller-inf-open
  ```
  Every settlement lands in `GET /marketplace/receipts` with the **tier the agent's card
  earned** (`anonymous` / `carded` / `human`) and is mirrored on chain to `ReceiptMirror`.
- Circle developer tools in the path: **Gateway x402** nanopayments (`exact` scheme,
  `eip155:5042002`), **developer-controlled wallets** signing every print, the **Agent
  Stack** buyer SDK (`@circle-fin/x402-batching`).

### The Graph — Best AI Use Case (Continuity)

The Graph is **load-bearing**: every x402 settlement is benchmarked *in the subgraph mapping*
against the print it could have seen, and that `slippageBp` is the only input TCA, seller
ratings and the reroute have ([`graph/README.md`](graph/README.md); Studio `ethonline`
**v0.2.0** on `arc-testnet`, ~3 s behind head). Meaningful work, not raw queries:

```bash
curl -s https://acr-api-1fto.onrender.com/tca/0x674055533B05Ec3fD135fC21c4d91a4A2D3193d3 | jq .reroute
make recompute                    # re-derive the index from the indexed tape and compare against the chain
```

**Ask the Tape** in natural language: [`skills/acr-analyst/SKILL.md`](skills/acr-analyst/SKILL.md)
(a schema map for any agent, usable with The Graph's Subgraph MCP) and [`mcp/`](mcp/README.md),
six read-only tools for any MCP host — `reroute_suggestion`, `seller_rating`, `query_tape`…
Substreams is N/A on Arc (Studio-only), stated rather than skipped.

### World — AgentKit Continuity

Distinguishing a bot from **an agent acting for a real, unique human**, durably:

- **One budget per person, not per wallet.** An agent's signed card may claim the human
  cluster `HumanIdMirror` records for its wallet this week; the gate confirms it on chain
  and meters every wallet that person owns as one. Try it on
  [`/developers`](https://arc-compute-rate.vercel.app/developers) — *as a demo human* →
  `tier: human`.
- **A proof, verified, then one TCA across all of a person's wallets** — runnable by a judge
  with nothing secret (the demo buyers' keys derive from public labels):
  ```bash
  make prove-human                # 401 challenge → CAIP-122 signature → /tca/human → the nonce is spent
  ```
- **The adversary model moves a published number.** `ACROracleV2` posts a
  `humanAdjustedBound` beside the wallet-denominated attack cost: sybils are free, people
  are not. `/tape` shows `human_share` per seller and `distinctHumans` vs `distinctPayers`.
- All demo identities are **World ID Sandbox** ones, flagged `sandbox` onto the chain and into
  every count. Feedback for the World team: [`FEEDBACK_WORLD.md`](FEEDBACK_WORLD.md).

---

## The four pillars

| Pillar | What it does | Where it lives |
|---|---|---|
| **1 — Observation model** | State-space (Kalman-class) deconvolution of the Gateway batching operator, with irregular observations. Recovers latent price from batched arrivals. | [`packages/acr_estimator`](packages/acr_estimator) |
| **2 — Hedonic adjustment** | Notional-weighted regression of log-price on seller quality (model class, latency SLO) → a constant-quality rate. Features come from `AttestationRegistry` or the tape's own attestations. | [`packages/acr_estimator`](packages/acr_estimator), [`contracts/src/AttestationRegistry.sol`](contracts/src) |
| **3 — Manipulation bound** | Lower bound on the USDC needed to move a print 1bp, as a function of trim α, cluster caps, and Arc's deterministic fees. Published *next to the rate*. | [`packages/acr_estimator`](packages/acr_estimator), [`redteam/`](redteam) |
| **4 — The instrument** | Cash-settled ACR future + Avellaneda–Stoikov market maker. No delivery, no bonds, no seller cooperation. | [`packages/acr_instrument`](packages/acr_instrument), [`contracts/src/ACRFutures.sol`](contracts/src) |

Supporting stages that aren't numbered pillars: the tape indexer (volume-time clock), the cleaning stack (Louvain sybil detection, funding-graph wash exclusion), and the robust estimator (α-trimmed volume-weighted median with a documented breakdown point).

---

## Quickstart

**Prereqs:** Python ≥3.11 + [uv], [Foundry] (`forge`), Node ≥20 + npm.

```bash
make setup        # uv sync --all-packages · forge install · npm install
make test         # pytest + forge + agent + terminal (node --test)
make ci           # what CI runs: lint + tests + the eval gate

make pipeline     # estimator on simulated exhaust → live ACR prints
make demo         # the 5-step "Attack the Index" demo
make eval         # ACR-vs-VWAP error series (the judge chart)

make api          # x402-gated index API on :8000
make terminal     # ACR Terminal on :3000

make anvil        # local chain on :8545   (then, in another shell:)
make onchain      # deploy → post signed prints → read back → settle a future
```

Everything runs **credential-free**. With no Circle or Arc keys set, the tape falls back to the calibrated simulator and the whole suite still passes — the live paths are additive, not required.

---

## For judges — the two-minute path

1. **Read** [`docs/SUBMISSION.md`](docs/SUBMISSION.md) — what is live, what is simulated, and the honesty tiers that separate them.
2. **Open** the [Terminal](https://arc-compute-rate.vercel.app). Hit the **plain** toggle in the masthead to re-set the entire site in beginner English; [`/companion`](https://arc-compute-rate.vercel.app/companion) is the glossary.
3. **Verify** the claims rather than trusting them:
   ```bash
   make verify-live      # every pillar, checked against the live deployment
   make eval-gate        # the headline attack numbers, CI-gated
   ```

The estimator's headline result, gated in CI so it cannot drift: under the paired demo attack (~$8k budget), **naive VWAP is dragged >100%** (measured 107–123%) while **ACR moves <3%** (measured 0.2–2.4%). Over the 12-hour eval series the attack-window VWAP error is **~57%** against ACR's **~1.2%** — roughly **46×** more resistant.

### Measured numbers

Measured, not aspirational — run `make verify-live` for the current set. At time of writing: hourly on-chain prints for 3 indices with attack-cost-per-bp on every one; **4** seller attestations on-chain; **three** live futures books (ACR-INF, ACR-GPU, ACR-DATA) whose maker is a Circle custody wallet, traded hourly by a keeper; **39** real Gateway x402 settlements from **3 distinct payers** (**27** from the CLI buyer agent, **7** from the autonomous hedger's backing EOA, **5** from a demo human's wallet — the first rows stamped with the tier the agent's card earned); 100% Foundry invariants passing.

---

## Repo map

| Path | What it is |
|---|---|
| [`packages/`](packages) | The estimator core: `acr_core` · `acr_estimator` · `acr_tape` · `acr_sim` · `acr_instrument` · `acr_oracle_client` |
| [`contracts/`](contracts) | `ACROracle` · `AttestationRegistry` · `ACRFutures` · `FeedAccessAttestor` (Foundry, unit + invariant suites) — all deployed on Arc testnet |
| [`services/index_api/`](services/index_api) | The x402-gated seller API (FastAPI) + the oracle poster + the venue keeper |
| [`apps/terminal/`](apps/terminal) | The ACR Terminal (Next.js) — prints, curve, tape, attack demo, ops console |
| [`apps/agent/`](apps/agent) | The machine buyer (TypeScript, Circle Gateway `x402-batching` client) |
| [`redteam/`](redteam) | The wash-flow adversary used to attack our own index |
| [`graph/`](graph) | The `acr-tape` subgraph: settlements benchmarked in the mapping, humans per window (The Graph, Studio) |
| [`mcp/`](mcp) | Six read-only MCP tools — Machine TCA for any MCP host, carded |
| [`skills/`](skills) | Two Skills published *back*: `acr-hedge` (discover → pay → read → hedge) and `acr-analyst` (Ask the Tape) |
| [`docs/`](docs) | Documentation — start at [`docs/README.md`](docs/README.md); `CONTINUITY.md` for what changed since the baseline |
| [`.github/workflows/`](.github/workflows) | CI (6 jobs) + the keepalive ping + the dispatch-only buyer |

---

## The Circle Agent Stack in ACR

All five pillars of Circle's Agent Stack are implemented, each with a credential-free offline mode and a live Arc-testnet path.

| Circle pillar | Where in ACR |
|---|---|
| **Agent Nanopayments** (Gateway x402) | Seller gate: `services/index_api/index_api/x402.py` → `/verify` + `/settle` on `gateway-api-testnet.circle.com`; scheme `exact` / GatewayWalletBatched on `eip155:5042002` |
| **Agent Wallets** | Buyer pays via `@circle-fin/x402-batching`; Developer-Controlled Wallets sign prints and attestations; user-controlled wallets trade the venue from the Terminal's Public Desk |
| **Agent Marketplace** | `GET /marketplace/catalog` (machine-readable listings with on-chain attestation provenance) and `GET /marketplace/receipts` (the public settlement tape) |
| **Circle CLI** | `make circle-login / circle-wallet / circle-fund / circle-deposit / circle-balance` — see [`docs/agent-runbook.md`](docs/agent-runbook.md) |
| **Circle Skills** | Consumed as a plugin, and **published back** as [`skills/acr-hedge/SKILL.md`](skills) |

Which Circle wallet product does which job, and the constraint forcing each choice, is [`docs/WALLETS.md`](docs/WALLETS.md).

---

## CI and automation

`ci.yml` runs **4 jobs on every push and PR** — `python` (ruff + pytest + the eval gate + a claim audit), `contracts` (`forge test`), `agent`, and `terminal` (node:test + a full Next build). It uses **zero secrets** and is fully hermetic: it stands up a local anvil, and a dedicated step fails the build if the on-chain suites *skip*, because a test that skips looks exactly like a test that passes — that is how a real regression once stayed green for a day.

A `keepalive` cron pings the free-tier seller API every 10 minutes and runs `verify_live.py` against the deployment, so a silently-dead pillar surfaces without anyone looking.

The four futures workflows (`futures-heartbeat`, `futures-lifecycle`, `futures-recover`, `x402-buy`) are **dispatch-only by design, not abandoned**. The heartbeat and lifecycle jobs were retired from cron on 2026-08-03: once the venue signed through Circle custody, a scheduled Actions run would have needed `ACR_CIRCLE_ENTITY_SECRET` — a credential controlling *every* developer-controlled wallet, including the oracle signer. That is a strictly larger blast radius than the scoped key it would replace, so the work moved into the in-process keeper on the trusted host. They remain as manual fallbacks if the keeper is ever stood down.

---

## Known limitations

Documented honestly and in full in [`docs/SUBMISSION.md` §8](docs/SUBMISSION.md) — including which surfaces are served by the simulator rather than the live Arc tape, and the original deploy EOA that is still an authorized `ACROracle` signer. The short version: the published tape on this deployment is `sim`, and the docs say so on the page rather than in a footnote.

---

## Documentation

| Doc | What it is |
|---|---|
| [`docs/SUBMISSION.md`](docs/SUBMISSION.md) | **Start here.** The judge-facing status page: what is live, the evidence, the honesty tiers, the limitations |
| [`docs/methodology.md`](docs/methodology.md) | The methodology paper — the estimand, the estimator, the manipulation bound |
| [`docs/ARCHITECTURE-DIAGRAM.md`](docs/ARCHITECTURE-DIAGRAM.md) | The architecture canvas explained zone by zone |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | Every technical term in plain English, with analogies |
| [`IMPLEMENTATION.md`](IMPLEMENTATION.md) | Implementation notes and the layout → blueprint mapping |

The full index, including runbooks and the build log, is [`docs/README.md`](docs/README.md).

---

## License

[MIT](LICENSE) © 2026 Kaustubh Agrawal

---

*ACR — one estimand, four pillars, ten arrows, seven weeks. The rate machine commerce settles on.*

[uv]: https://docs.astral.sh/uv/
[Foundry]: https://book.getfoundry.sh/
