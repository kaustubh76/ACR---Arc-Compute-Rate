# ACR — Submission

**Arc / Circle 7-week Hackathon · Agentic Economy track · Halfway checkpoint 2026-07-27 · Ship-week update 2026-07-29 · Final update 2026-08-08**

> **ACR (Arc Compute Rate)** is "SOFR for machine commerce" — a manipulation-resistant reference-rate family that recovers the *latent constant-quality price of machine services* from the noisy, batched, adversarial payment exhaust on Circle's Arc L1, and publishes it as a live on-chain benchmark that contracts can settle against.
>
> *"Machine commerce just got its SOFR — and it prints its own attack cost."*

This is the one-page status for judges. For depth: [`docs/ARCHITECTURE-DIAGRAM.md`](ARCHITECTURE-DIAGRAM.md) (architecture blueprint), [`docs/methodology.md`](methodology.md) (estimator spec), [`IMPLEMENTATION.md`](../IMPLEMENTATION.md) (how to run), [`docs/IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) (full status), [`docs/presentation.md`](presentation.md) (the long-form deck — `make deck` renders HTML + PDF). **The deck actually presented** is the 8-slide [`docs/pitch/deck.html`](pitch/deck.html) (`make pitch` → [`docs/pitch/index.html`](pitch/index.html) + [`docs/pitch.pdf`](pitch.pdf)), with the spoken argument, objection handlers and frozen facts in [`docs/PITCH.md`](PITCH.md). **The form itself** is answered field-by-field in [`docs/submission-brief.pdf`](submission-brief.pdf) (source [`docs/pitch/brief.html`](pitch/brief.html), same `make pitch`) — title, description, track, account email, products used, MVP, diagram, docs and product feedback, each with paste-ready text.

---

## 1. One loop

An index is a number someone publishes. **A benchmark is a number something settles against** — and that is the whole difference between this and a dashboard. `ACRFutures` reads `ACROracle` in five places, and **settlement refuses a print older than two hours**, so the feed has a dependent that breaks when the feed breaks. There is a contract on Arc whose money stops moving if this number goes stale.

That closes on itself in one loop, and every part of the submission is a rung on it:

1. **Measure.** The estimator recovers the latent constant-quality price from Arc's payment exhaust and prints it hourly, on-chain, EIP-712-signed by a Circle custody wallet.
2. **Sell it to machines.** The print is behind an x402 gate on Circle Gateway. Agents discover it, pay a nanopayment, and get it — no account, no key, no invoice.
3. **Settle against it.** The futures venue cash-settles on that same print, refusing one older than two hours.
4. **Close the loop.** The autonomous hedger does both legs, and the joint between them belongs to the contract rather than the agent: **it pays for the print, and `ACRFutures` fills its trade at that same print, so the position it ends up holding is the print it bought, priced.** It pays $0.0001 for the rate, reads its own book, sizes the gap to its mandate, and trades the difference — from a Circle agent wallet, with no human in the loop.

That fourth rung is the product in one sentence. Every other machine here does one leg: the CI buyer pays for data it never acts on; the heartbeat trades without paying for what it trades on. The hedger is the one that makes an economic decision — and it does not ask you to take its word for the join. `ACRFutures.trade` fills at `oracle.latestValue(indexId)` and emits it, so the number the agent paid for is the number it was filled at, by construction rather than by assertion. [`GET /hedger`](https://acr-api-1fto.onrender.com/hedger) puts both halves side by side from sources a stranger can reach without us: the Circle Gateway batch references its own wallet settled, and the position and collateral those prints bought, read off the venue. The Terminal's `/exchange` prints the arithmetic that joins them, so a reader can check it instead of believing it.

The rest of this page is the cast that runs that loop, the evidence each claim rests on, and what we did not build.

---

## 2. The economy of agents

Six wallets, six mandates, one loop. This is also the Circle Agent Stack coverage — every pillar is a cast member rather than a checkbox, and the compact pillar→code map for scoring is in [Appendix B](#appendix-b--circle-agent-stack--code-judges-map).

| Agent | Circle wallet type | What it pays | What it decides | Where its log is |
|---|---|---|---|---|
| **The press** | Developer-Controlled custody `0x8366968f…` | Arc gas, ~0.41 USDC/day, to sign and post three prints an hour | **Nothing — deliberately.** It publishes what the estimator computed; a benchmark whose publisher exercises judgement is a quote | `PricePosted` on ACROracle; `/ops` carries the cadence |
| **The maker** | Developer-Controlled `0x9D44A7Dd…` | Collateral behind every book, and the gas to open each successor series | Nothing per-trade: it is the mirror side of every fill by construction, so the venue's net position is always zero | `Traded` on ACRFutures; desk on `/curve` |
| **The heartbeat taker** | Developer-Controlled `0xc972642F…` | Gas for one mean-reverting fill an hour | Size, via the same margin check the public desk uses — clamped against *both* sides | The public trade tape |
| **The hedger** | **Agent wallet.** SCA `0x1Dc707E3…` trades; backing EOA `0x71E140D9…` pays, because EIP-3009 needs a signature `ecrecover` can verify | $0.0001 per print over x402, plus collateral top-ups | Everything: whether to buy the print, whether it is margin-bound or the book is full, how far it sits from its 2.5-contract mandate, and whether to refuse | `GET /hedger` — position, collateral and fills read off ACRFutures; receipts and spend off the public settlement tape at `/marketplace/receipts`, because a Gateway batch UUID is on no chain to read. It also writes `data/hedger_decisions.jsonl` wherever an operator runs it, but that path is gitignored *and* dockerignored, so nothing on this page rests on a file you cannot open |
| **The reader** | **User-controlled SCA**, PIN ceremony in Circle's hosted UI — the key exists only client-side and this server never holds it | Nothing: Gas Station sponsors it, confirmed from the ERC-4337 `UserOperationEvent` paymaster rather than a fee field | Their own trade, and their own exit — `settle` is permissionless | The same public tape; the Public Desk on `/curve#desk` |
| **The CLI buyer** | Raw EOA `0x784e6d2d…` driving `@circle-fin/x402-batching` | $0.0001 a query across 13 priced resources | Which listings to buy, from the catalog | `services/index_api/index_api/receipts_live.jsonl` |

**We consume Circle's Skills and publish one back.** `make skills-install` installs Circle's four; [`skills/acr-hedge/SKILL.md`](../skills/acr-hedge/SKILL.md) is ours, and it teaches any agent the loop above — discover, pay for the print, read the venue, hedge — with the two gotchas that cost us the most time (the webcrypto flag `services pay` needs, and the WAD-integer quantity `trade` needs).

**App Kits close the last operator step.** Gateway deposits were a human running the CLI; `make gateway-deposit` ([`apps/agent/src/deposit.ts`](../apps/agent/src/deposit.ts), Unified Balance Kit) makes it something an agent does for itself. Proven with a real 0.5 USDC deposit on Arc — [`0xd6bab6ee…`](https://testnet.arcscan.app/tx/0xd6bab6eeba29b69fe1d6ca47ac98b3f5c507053fa3eb315a7a582dbdadd38858), block 55751879.

**The circularity, named.** Both sides of the futures book are ours, and both x402 payers are ours. Growing the receipt tape from 11 to 34 bought twenty more proofs that the rail works and not one more customer. What is real is the mechanism: real USDC, real signatures, real settlement, and an agent whose two legs are separately checkable by anyone — its payments as Gateway batch references on the public receipts tape, its position and fills as Arc transactions. What is not yet real is demand.

---

## 3. The three indices

| Index | Measures | Latest on-chain value (Arc testnet) |
|---|---|---|
| **ACR-INF** | Inference — $/1k tokens | **0.49236** |
| **ACR-GPU** | GPU compute — $/GPU-sec | **0.01110** |
| **ACR-DATA** | Data egress — $/MB | **0.00209** |

Every hourly print ships **three numbers, not one**: the rate, a **confidence interval**, and an **attack-cost-per-bp** — the USDC an attacker must burn to move the print by one basis point (e.g. ACR-INF attack-cost-per-bp ≈ **0.0094 USDC/bp**). Values read live from ACROracle at final submission (2026-07-31); posts run **in-cloud, hourly, signed by the Circle Developer-Controlled custody wallet** (e.g. `postPrint` [`0xa26c…643f`](https://testnet.arcscan.app/tx/0xa26c5977dcd8408f29e35f426f0ac6df0a26491ac39c056184a78bb1a7af643f)).

---

## 4. What's live right now (real, on Arc testnet — chain 5042002)

**Public URLs**
- **Dashboard (Terminal):** https://arc-compute-rate.vercel.app — never a blank page: the shell paints instantly and a six-tier *connection ladder* (`live → stale → waking the press → on-chain reads → archived`) keeps every value honestly labeled. When the free-tier API sleeps, the Terminal reads prints **directly from ACROracle with viem** (`/api/onchain`, CDN-cached) — even the fallback is on-chain truth.
- **Seller API:** https://acr-api-1fto.onrender.com — `/health` reports gate `circle`, 3 live indices, chain 5042002; `/onchain/{id}` serves the real on-chain print; `/x402/info`, `/marketplace/catalog`, `/marketplace/receipts`, `/webhooks/circle` all live. Hourly `postPrint` runs in-cloud via the **Circle Developer-Controlled custody signer**, kept awake by a 10-minute CI ping (`.github/workflows/keepalive.yml`) plus a post-on-wake catch-up if the press ever oversleeps its slot.

**On-chain contracts** (explorer: `https://testnet.arcscan.app`)
- **ACROracle** [`0x4f00e3BDd224F4c4b4958D54cD774E84B9092609`](https://testnet.arcscan.app/address/0x4f00e3BDd224F4c4b4958D54cD774E84B9092609) — hourly EIP-712-signed prints; `ecrecover` signer auth; monotone-ts + print-within-CI + bound-sanity enforced.
- **AttestationRegistry** [`0x23ae3E1A306824F0CBA0b6561cB7E5502f63dFb7`](https://testnet.arcscan.app/address/0x23ae3E1A306824F0CBA0b6561cB7E5502f63dFb7) — 4 real seller attestations (the hedonic-quality flywheel).
- **ACRFutures** [`0x29d97c629a8278f7ec4218ab0bd8baa9182642fe`](https://testnet.arcscan.app/address/0x29d97c629a8278f7ec4218ab0bd8baa9182642fe) — cash-settled futures on the print: Arc-native USDC collateral, 20% initial margin, settlement print must be ≤ 2 h old, socialized-loss clearing. Series roll themselves: the **in-process keeper** on the trusted host derives which indices have a live book and rolls each before it expires (`futures-lifecycle.yml` is the dispatch-only manual fallback). Desk + trade tape on the Terminal's `/curve`. **Settling is permissionless** — anyone may close an expired series, and since 2026-08-06 a reader can do it from their own PIN-secured wallet on the Public Desk, paying their own gas, rather than waiting for our cron.
- **FeedAccessAttestor** [`0xe671a8E73900F1186448cFFeA9e730F5E50DFD47`](https://testnet.arcscan.app/address/0xe671a8E73900F1186448cFFeA9e730F5E50DFD47) — **an off-chain x402 payment, made checkable on-chain.** Gateway settles nanopayments off-chain and returns a batch UUID; nothing on-chain can see that, so "this wallet paid for the feed" normally lives only in a seller's ledger. We asked Circle directly at their Agent Stack session, and their answer was that you would need "an EIP-712 signed attestation or oracle receipt to cryptographically verify the off-chain x402 payment on-chain". So we built it: the seller signs a `FeedAccess` struct with **the same Circle custody wallet that signs oracle prints**, anyone may relay it, and the contract recovers the signer with `ecrecover`. **Proven live** — the 3 settlements this agent's backing EOA (`0x71e140d9…`) had made **at the moment the grant was signed** were attested to its smart account, and `hasFeedAccess(0x1Dc707E3…)` returns **true** through 2026-10-03 ([redeem tx](https://testnet.arcscan.app/tx/0x70f4e9b26f44ac3bec18ca7426f77b27c5717a48725ae1951eed6c97a0766442)) — access is deliberately time-boxed, so check the tx if the window has since lapsed. (§4 counts more settlements from that payer today: a grant is a signature over a window, not a running total, so it is not re-signed each time a receipt lands. The number in the attestation is the count it was derived from, and the gap is the agent having gone on working.) Off-chain revenue became an on-chain right, which is what lets a venue rebate fees to wallets that paid for the index. The seller *signs*, it does not *decide*: every attestation is derived from rows already public at `/marketplace/receipts`, so it cannot mint access nobody paid for. Until 2026-08-06 this contract was named on no surface of the product; it is now in the Terminal's colophon and its `/developers` contract card.
- **The Public Desk** — a reader opens a Circle **user-controlled** wallet in the browser (SCA on Arc; PIN ceremony in Circle's hosted UI, so the key exists only client-side and this server never holds it), takes a faucet stake, and trades the venue for real. Full lifecycle: `approve` → `postCollateral` → `trade` → **`withdrawCollateral`**, plus permissionless `settle` at expiry. Every action is a server-minted challenge the reader authorizes with their PIN; guardrails (one drip per session-derived wallet, live margin-feasible sizing against *both* sides' checks, expiry gating, rate limits) are server-side. Gas Station sponsorship confirmed from the ERC-4337 `UserOperationEvent` paymaster, not from a fee field. **Honest framing:** the stake is our testnet grant and the maker on the other side is our own bot — the wallet, the PIN, the margin maths, the fills and the settlement are real.
- **Every wallet that operates the system is a Circle wallet.** The press signs prints from the Developer-Controlled custody wallet `0x8366968f84a343CF70941EBe858428643d825cb0` (verified `setSigner` + Circle-signed+relayed `postPrint`); the futures venue is **owned** by the Developer-Controlled maker `0x9D44A7Dd4e7bF173B3F13ee41E1B60C8e92388d2`, which also stands behind the book; the heartbeat trades from a third, `0xc972642F1489E7345729e33d0606AF8dC401C8ec` (the contract refuses a maker taking its own quote). The original deploy EOA `0x33189c…` was handed the venue over and holds no authority over **ACRFutures** — not owner, not pending owner. It **does** remain an authorized `ACROracle` signer and that contract's owner: a raw offline key, deliberately left in place and named as an open item rather than quietly fixed (the sharpest version of this admission is in [`CIRCLE-SESSION-QUESTIONS.md`](../CIRCLE-SESSION-QUESTIONS.md) §H — revoking it is a one-line `setSigner`, and any judge can check either fact with `cast call`). Readers trade from their own Circle **user-controlled** wallets, and the autonomous hedger runs on a Circle **agent wallet**. Which product does which job, and the constraint forcing each choice: [`docs/WALLETS.md`](WALLETS.md).

**Proven x402 settlement (real USDC moved)**
**The systems ledger** (`/ops`, linked from the colophon) is the press checking *itself* on a 15-minute timer and publishing the result: oracle print ages, venue series, keeper standing, tape source, gate mode, hedger, wallet runway. It does **not** replace `make verify-live`, which probes the deployment from outside over the public internet and catches what an in-process check structurally cannot; the page says so. It deliberately carries **no archived fallback** — every other surface falls back to the bundle because an old print is still a true print, but an old *verdict* asserts the health of a service that is not answering, so a cold press renders "no verdict" instead. Behind an optional key (`ACR_OPS_TOKEN`, unset → the routes 404) the same page exposes the money-moving Makefile targets — settle, roll, collateral top-up, treasury transfer, withdraw, pause — each dry-run by default, capped server-side, and appended to an audit trail including its refusals.

**Two distinct payers** have settled real USDC through Circle Gateway against this gate — the count that matters, because revenue from a single wallet we control proves plumbing rather than demand. The durable, in-repo artifact is [`services/index_api/index_api/receipts_live.jsonl`](../services/index_api/index_api/receipts_live.jsonl): **34 Gateway-settled receipts** (re-measured 2026-08-08 against the live `/marketplace/receipts`), scheme `exact`, `eip155:5042002`, $0.0001 each, deduped by `tx_ref`. It lives under `services/` rather than `data/` because that directory is in both `.gitignore` and `.dockerignore`, so a file there reaches neither the repo nor the image — an earlier version of this claim was false for exactly that reason.

The payers are the CI buyer agent (`0x784e6d2d…`, 27) and the **autonomous hedger's Circle agent wallet** (`0x71e140d9…`, 7). That second address is the agent's *backing EOA*: the x402 `exact` scheme is EIP-3009 and the facilitator `ecrecover`s it, so Circle signs with an EOA even though the agent's smart account (`0x1Dc707E3…`) is what `ACRFutures.trade` records as the taker. Two addresses, one agent — see [`docs/WALLETS.md`](WALLETS.md).

Counters survive a restart: production has no persistent disk, so `/revenue` read `paid_queries: 0` over a gate that had genuinely been paid until the archive shipped inside the image. Measured across two independent restarts, it holds and does not double. Circle's own CLI also paid the gate end-to-end (§4). Settlement refs are Gateway **batch UUIDs** (GatewayWalletBatched) — the honest transaction story is *x402 payments + Gateway batch settlements + the oracle's own `postPrint` txs*, not "N L1 transactions."

**Verify any of it yourself:** `make verify-live` (every pillar of the deployed product, one exit code), `make verify-claims` (re-measures every number these docs assert, including this page and the deck), `make print-gaps` (the on-chain press cadence against the 120-minute settle window), `make x402-capture` (fold new settlements into the durable archive).

---


## 5. Verification evidence (each gate dated where it differs; suites re-measured 2026-08-08)

Every gate below was executed and its result captured verbatim. The dates are
deliberately not uniform: a row says when *that* gate last ran, because a single
banner date across rows measured days apart would be the kind of claim this
section exists to prevent. The suite counts, the build shape and the lint were
re-measured on 2026-08-08; the on-chain ceremonies carry their own dates. The same gates
run on every push as **GitHub Actions CI — 4 jobs (python / contracts / agent /
terminal), all green** (`.github/workflows/ci.yml`).

| Gate | Command | Result |
|---|---|---|
| Lint | `ruff check packages services scripts redteam` | ✅ All checks passed |
| Desk preflight | `make desk-preflight` | ✅ CLEAR TO RUN — series life, margin capacity both directions, custody funding, faucet slots |
| Desk round trip on Arc | `make desk-e2e` → `make desk-evidence` | ✅ stake → collateral → trade → **withdraw**, confirmed by four independent witnesses (venue balance, contract state, wallet balance, `CollateralWithdrawn` + paymaster) |
| Real-tape audit | `scripts/tape_audit.py` | ✅ measured: ~18.5k real Arc settlements collapse to **one** price, so no index is publishable from them — the `sim` label is earned, not assumed |
| Glossary coverage | `scripts/check_glossary_coverage.py` | ✅ 423/423 diagram terms defined |
| Python suite | `pytest packages services tests` | ✅ **367 passed** — including 9 anvil-gated on-chain tests that CI now genuinely runs (a node is started in the job) rather than silently skipping |
| Resistance gate | `scripts/eval.py --hours 12 --check` | ✅ all 4 checks PASS |
| Contracts | `forge test -vvv` | ✅ **60 passed** (17 oracle + 10 registry + 16 futures + 10 feed-access attestor + 7 invariants, `fail_on_revert=true`) |
| Buyer agent | `npm run build && npm test` | ✅ tsc clean, **10/10** |
| Terminal | `npm test && next build` | ✅ **95/95 node tests** (12 suites: buy plan · connection ladder · oracle codec · futures codec · edition · glossary · plain-edition coverage · desk phase · futures book · read result · chain constants · price formatting) + clean build (9 pages + 18 API routes) |
| Buyer-SDK interop | `make interop` | ✅ **12/12** (our 402 parses exactly as Circle's `GatewayClient` — re-run **2026-08-06** against the **deployed** gate) |
| On-chain read | `make verify-testnet` | ✅ chain id + contracts' bytecode + 3 live prints read from Arc (+ `cast code` shows bytecode at ACRFutures) |
| Press cadence | `GAP_PAGES=24 make print-gaps` (re-measured **2026-08-06**, read off the chain, not the API) | ⚠️ **37.2 h window, 48 press runs: median gap 60.3 min, mean 47.5, max 153.3 — one gap over the 120-min settle window** (08-05 18:38 → 21:11 UTC, all three indices). The 08-05 reading of this row was 18.8 h / 19 runs / max 60.6 / zero breaches; it was true when taken and the breach happened after it. Reported rather than quietly re-scoped to a window that excludes it: for those 2.5 hours the venue could not have been settled. The self-ping fixed the *systemic* 216-minute gaps (the pre-fix tape) — it does not make a single miss impossible, and `/ops` now carries this measurement continuously instead of only when someone runs the command |
| Strict liveness | `VERIFY_STRICT=1 make verify-live` (2026-08-05 — strict mode also fails on funding runway and book capacity, not just outages) | ✅ **ALL PILLARS LIVE** (re-run 2026-08-06 against the redeployed press) — oracle, venue, tape, seller, x402, public desk, hedger, terminal, funding (custody 16 days of runway; maker and taker above their floors), keeper traded within the hour. **One strict-mode warning stands: the ACR-GPU book is ~3.2 reader-trades from freezing** and deepening it would take the maker below the 2.50 floor that funds the next roll — a funding decision, not a code one, so it is reported rather than papered over |
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
- **CI actions are pinned several majors behind.** `actions/checkout@v4`, `actions/setup-node@v4` and `astral-sh/setup-uv@v5` are current-at-v7 / v7 / v9, so every run logs a Node-20 deprecation warning and GitHub force-runs them on Node 24. All four jobs pass today; the bump is deliberately deferred rather than risked on submission day, when a green pipeline is worth more than a clean warning log.

**Two Circle products we did NOT use, said plainly rather than implied:**

- **Smart Contract Platform.** Every deployed contract went out through Foundry. `scripts/deploy_circle.py` exists, is unit-tested, and has never deployed anything but a dry run — so the platform is not claimed anywhere on this page. A tested code path is not a shipped one.
- **CCTP and cross-chain.** Single-chain by construction: the benchmark's dependents live where it prints, and a cross-chain oracle would add a bridge to a design whose whole argument is that fees on one chain make the attack cost a number. Multi-chain is roadmap, not coverage.

---

## 9. Where this goes next

**Arc public mainnet is 2026-09-16.** ACR is built to be market infrastructure on day one rather than a testnet exhibit: the estimator, the oracle, the venue and the gate all move chain-first, and the only Arc-specific assumptions are the ones that make the manipulation bound a number at all (deterministic USDC fees, USDC as gas, sub-second finality).

The three things standing between here and that date, in order:

1. **A dependent that is not us.** The venue settling on the feed is a real dependent, but we deployed both. One outside consumer — a listing on the Agent Marketplace that a stranger's agent pays, or a second venue reading the oracle — converts the strongest structural claim on this page from "our two components agree" to "someone else is exposed to this number."
2. **The marketplace listing.** Submitted 2026-08-04, still not listed (§4). Circle's Discovery API carries no Arc network at all today; when it does, we already meet every prerequisite.
3. **A community, and something for it to hold.** Post-hackathon: **$GPOOR**, a fair-launch token on ACTFUN, Arc's own community-mined launchpad — you mine it by complaining about compute prices on-chain, with the live ACR print in the complaint. It is a joke that funnels to the thesis, and it belongs *after* a submission rather than inside one: the mining window is an hour, and a launch nobody can mine is not a fair launch. **Stop whining. Hedge.**

---

## Appendix A — the 7-week roadmap

Kept because judges scoring against the original scope need it, and moved out of the flow because chronology is not the product. Every week is shipped.

**All seven weeks of scope are shipped.** The estimator, on-chain layer, adoption surface, red-team, and instrument layer are built and running — and the W6 instrument is now **live on-chain**: a cash-settled futures venue trading against the oracle print.

| Week | Focus | Deliverable | Status |
|---|---|---|---|
| **W1** | TAPE | Indexer on Arc + batching study | ✅ Done — `SimSource` (calibrated) + `ArcSource` (decodes real Arc USDC `Transfer` logs at `0x3600…0000`) behind one `TapeSource` interface |
| **W2** | ESTIMATOR v1 | Methodology paper + first live prints | ✅ Done — four-pillar estimator live; [`docs/methodology.md`](methodology.md) published |
| **W3** | ON-CHAIN | Registry + Oracle + invariant suite | ✅ Done — contracts deployed on Arc testnet; full Foundry suite incl. invariants (`fail_on_revert=true`) |
| **W4** ★ | ADOPTION | Sellers attest + x402 index API live | ✅ Done — x402 gate live on Circle Gateway; **real machine-to-machine settlement proven on-chain**; 4 seller attestations on-chain; public cloud API |
| **W5** | RED TEAM | Manipulation bound + attack own index | ✅ Done — `redteam/` wash + optimal-attack harnesses; attack-cost-per-bp on every print; CI-gated resistance claims |
| **W6** | INSTRUMENT | Weekly cash-settled future + A-S MM | ✅ **Live** — `ACRFutures` deployed on Arc ([`0x29d9…42fe`](https://testnet.arcscan.app/address/0x29d97c629a8278f7ec4218ab0bd8baa9182642fe)): **three live books** — ACR-INF, ACR-GPU and ACR-DATA, 10× multiplier each — cash-settling against the oracle print, with an in-process keeper rotating an hourly fill across them. The maker standing behind the book is a **Circle developer-controlled wallet** and an **autonomous agent** buys the print over x402 then trades on it; `acr_instrument` (Avellaneda–Stoikov MM) serves the term structure |
| **W7** | SHIP | Freeze + paper polish + rehearse | ✅ Done — repo 100% pushed; 4-job GitHub CI green; Terminal hardened (connection ladder, instant shell, direct on-chain reads) and redeployed; cloud posting re-enabled via Circle custody + keep-alive; deck re-rendered at final submission |

---

## Appendix B — Circle Agent Stack → code (judge's map)

| Circle pillar | Where in ACR |
|---|---|
| **Agent Nanopayments** (Gateway x402) | Seller gate `services/index_api/index_api/x402.py` → `/v1/x402/verify`+`/settle` on `gateway-api-testnet.circle.com`; scheme `exact`/GatewayWalletBatched on `eip155:5042002` |
| **Agent Wallets** | **All three Circle wallet models, live.** Buyer `apps/agent/` pays via `@circle-fin/x402-batching` `GatewayClient` (raw EOA); the oracle signs prints via Circle **Developer-Controlled** Wallets (`packages/acr_oracle_client/signer.py`); and any reader trades the futures venue from a Circle **user-controlled** SCA on the Public Desk — their PIN is the only thing that can sign, Gas Station pays (`services/index_api/index_api/desk.py`, `apps/terminal/components/chain/PublicDesk.tsx`) |
| **Agent Marketplace** | `GET /marketplace/catalog` (Bazaar-shaped listings + on-chain attestation provenance); `GET /marketplace/receipts` (public settlement tape); Terminal `/exchange` |
| **Circle CLI** | `make circle-login / circle-wallet / circle-fund / circle-deposit / circle-balance` — `docs/agent-runbook.md`. **Proven end-to-end**: Circle's own CLI buyer settled against the deployed gate (`circle services inspect …/prints` → `payable`; `circle services pay` from a faucet-funded agent wallet paid $0.0001 and received the full prints payload) |
| **Circle Skills** | Consumed **and published back**: `circle-skills` Claude Code plugin (`make skills-install`), and [`skills/acr-hedge/SKILL.md`](../skills/acr-hedge/SKILL.md) teaches any agent the discover → pay → read-venue → hedge loop |
| **App Kits** (Unified Balance) | `make gateway-deposit` → `apps/agent/src/deposit.ts` (`@circle-fin/unified-balance-kit`); the Gateway top-up an agent can do for itself. Real deposit `0xd6bab6ee…` |

**Discoverability, measured rather than assumed.** Circle's public Discovery API
(`api.circle.com/v2/x402/discovery/resources`) serves **958 listings and every
one is on a mainnet chain**; `network=eip155:5042002` returns **zero**, and no
Arc network appears at all. We meet every listing prerequisite — 402 when
unpaid, we serve on payment, we publish an OpenAPI spec, and the payout wallet
is a Circle developer-controlled wallet — so the only thing disqualifying us is
the chain. The listing form is submitted (`MARKETPLACE-LISTING.md`) and Circle
say testnet listing works; **we do not claim ACR is listed**, because the
Discovery API disproves that in ten seconds. Of the four third-party registries
Circle points sellers at, only **Proceeds** carries Arc — `arc-testnet` is a
first-class network there and its settlement schemes even include `nano`
("Circle Gateway batching"). We evaluated it against their live API and
**declined**: Proceeds is a *paying proxy*, so listing would mean admitting its
forwarded calls on a static bearer secret instead of an on-chain settlement — a
weaker guarantee than the one this seller exists to make. x402scan, Blockrun and
Sponge expose no reachable API and remain unevaluated.
