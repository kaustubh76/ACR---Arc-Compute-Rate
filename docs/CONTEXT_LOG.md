# ACR — Context Log (deep session reference)

> **What this is.** The deep-context companion to [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md). Where STATUS says *what the codebase is right now*, this log says **why & how it got there**: the full audit findings, every design decision and its rationale, the verification evidence, and the researched Circle/Arc API facts (with source URLs). It exists so a future session can reconstruct the reasoning — not just the result — after this conversation's context window is gone. Everything here is drawn from the actual work done; file:line references and numbers are as recorded during the sessions.

---

## 0. Doc hierarchy — which doc for what

| Doc | Read it for |
|---|---|
| [`Readme.md`](../Readme.md) | The architecture blueprint (the excalidraw canvas README): zones, the ①–⑩ flow, "Why Arc". |
| [`docs/methodology.md`](methodology.md) | The estimator **spec**: estimand, four pillars, the manipulation bound, evaluation targets. |
| [`IMPLEMENTATION.md`](../IMPLEMENTATION.md) | The blueprint→zone map + the **go-live** how-to (env, make targets). |
| [`docs/IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) | **Current state**: file map, subsystem real-vs-stub table, decisions-not-to-undo, test status, landmines. |
| **`docs/CONTEXT_LOG.md`** (this) | **Deep reference**: the audit narrative, decision rationale, research facts + sources, verification evidence, working method. |

Fast path for a new session: read STATUS first, then this for depth on any point.

---

## 1. Work timeline (the conversation arc)

Four requests, each a distinct deliverable:

1. **"Check and rethink that the core infra is robust and up to the requirements … not just average execution."** → A full audit against the repo's own docs, then a hardening remediation. **Session 1** below.
2. **"Arc, USDC, Circle Wallets, Circle Contracts, Nanopayments, Paymaster."** → Wiring the *real* Circle/Arc stack (the prod paths the audit found were stubbed). **Session 2** below.
3. **"Make a clear implementation md … so we can context that to the next Claude session."** → `docs/IMPLEMENTATION_STATUS.md` (the concise handoff).
4. **"Add the context window information as comprehensive as possible … for best reference."** → This doc.

No git commits were made in any session — the entire tree is an untracked working copy.

---

## 2. Session 1 — core-infra hardening (deep dive)

### 2.1 Method
Three `Explore` sub-agents ran in parallel over (a) the Python packages, (b) services/scripts/app, (c) contracts/redteam + methodology. Their findings were then **independently verified by reading the exact source lines** before any change — the audit did not trust summaries. A `Plan` agent designed the remediation; the user chose scope; execution was 8 phases (P0 baseline → P8 CI), verifying after each.

### 2.2 Verdict
Solid, well-structured demo skeleton — but **8 load-bearing guarantees were documented, not implemented**. The remediation made the claims true (or corrected the docs to measured reality), never re-scoped the product away.

### 2.3 The 8 truth-gaps (wrong → right, with locations)

| # | Location | Was (claim ≠ code) | Fixed to |
|---|---|---|---|
| 1 | `bound.py:11-14` (docstring) vs `:56-83` | Docstring said the cluster cap/α shape the number; code appended injected wash **raw** as one pseudo-observation → priced an attack on the **undefended** median. | Cap-aware **defended** bound: cap → required # of cleaning-evading sybil clusters (> `SYBIL_MAX_SIZE`) → identities + funding-leg fee. `redteam/optimal_attack.py` runs the priced attack through real `clean()` to prove attainability. |
| 2 | `pipeline.py:133-135`, `:138-139` | Whole Kalman deconvolution collapsed to `tilt=last−mean(obs)` clipped ±5%; CI silently widened to cover the tilt. Bars built from *all* window notional (wash shifted them). | Variance-shrunk tilt (`lam=τ²/(τ²+var)`); smoother uncertainty flows into the CI (value∈CI by construction). Bars from **cleaned** weights, reusing `volume_time_bars`. |
| 3 | `ACROracle.sol` (no sig logic), `client.py:183` | "EIP-712 signed prints" in docstrings/methodology §7, but the contract had zero signature verification and the client signed only the tx envelope. | Real EIP-712: `PRINT_TYPEHASH` + domain "ACR Oracle"; `postPrint` recovers + checks the signer; `client.sign_print` via `Account.sign_typed_data`; a digest-parity test asserts Python ≡ Solidity. |
| 4 | `scripts/_out/eval.json`, `test_estimator.py` | Docs claimed ">100% VWAP, ~1–3% ACR, 50–200×"; committed eval showed **attack VWAP 7185bp = 71.85%**, ratio ≈56×; the only test asserted merely `vwap>10%` / `acr<vwap/2`. | Eval **gate** (`eval.py --check`, exit 1 on breach) + `tests/test_claims.py` asserting both scenarios; docs rewritten to the *measured* numbers (see §6). |
| 5 | `adversary.py:81-82,107-108`; `cleaning.py:126`, `:115-118` | Sim adversary used disjoint buyer (`0xsybilB*`) / seller (`0xsybilS*`) namespaces and never emitted the funding leg → self-dealing (`buyer==seller`) and reciprocal-wash-cycle detectors were **dead paths** in every test/demo. | `adversary.py` now emits self-deals + on-tape reverse funding legs + a pure-sybil ring (two disjoint sub-clusters). All 4 defenses fire; attack neutralized (`test_cleaning.py`). |
| 6 | `ACROracle.sol:83`; `store.py`; `poster.py` | Poster-supplied `uint64` ts with only monotonicity → one huge ts **bricks the feed forever** (no pause/reset). No staleness view. API computed prints **once**, never refreshed → `vol` always 0.0; `OraclePoster.run()` never scheduled. | Contract: `timestamp ≤ block.timestamp + MAX_TS_SKEW`, `isStale`/`latestPrintWithAge`, `setPaused`, two-step ownership. Service: FastAPI **lifespan** refresh loop (prints evolve, vol real) + poster scheduling; `store.py` rolling-window + lock/copy-on-write. |
| 7 | `AttestationRegistry.sol:64-90` | `attestWithSig` had no nonce/deadline and ignored the signed timestamp → **replayable forever**; an old sig could overwrite newer metadata (hedonic poisoning). | Per-seller **nonce + deadline** in the typed struct; replay + expiry tested. |
| 8 | `mathutils.py:83-101`, `:104-119` | `breakdown_point()` returned a constant `0.5`; `gross_error_sensitivity` was exported but **never called** — so methodology §4's "per-actor influence bounded by caps" wasn't computed for any print. | Per-print `RobustnessDiagnostics` (`robustness.py`): single-cluster flip fraction (finally uses `gross_error_sensitivity`), leave-one-community-out influence in bp, clusters/identities required — surfaced in the API/Terminal. |

Plus numerics (Kalman `solve`+jitter instead of raw `inv` on near-singular covariances; hedonic sqrt-weight fallback + real R²; `mathutils`/`robust` guards; MM ask clamp), the PrintStore threadpool race (lock + copy-on-write), lifespan, bounded x402 counters, Terminal SSR crash-guard + fetch timeout + honest snapshot (removed a stale committed anvil oracle address), and a CI workflow.

### 2.4 Empirical discoveries that shaped the design (non-obvious, load-bearing)
- **`clean()` ≈ 0.11s** on a ~14.5k-event window (Louvain included). A fully-empirical bound (re-cleaning at each of ~80–240 binary-search steps) would be 10–30s/print → **ruled out**; chose an *exact analytic cap accounting validated empirically* instead.
- **Sybil-zeroing, not the cluster caps, is the real resistance.** During attack hours `eval.json` shows `cleaned_pct = 95.0` *exactly*: the sole honest community is scaled to exactly the 5% cap while all wash is zeroed — and uniform cap-scaling of one community is **median-invariant**. So the cap contributes ~0 to stability; the sybil flag does the work. This is *why* the cap-aware bound must model a sybil-flag-**evading** adversary (fresh clusters > `SYBIL_MAX_SIZE=40`), or it prices the wrong attack.
- The docs **conflated two scenarios** (a 1h paired demo vs. a 12h eval series) with different numbers — each is now scoped and gated separately.

### 2.5 User decisions (Session 1)
- **Scope:** the **full P0→P2 sweep** (all 16 findings), not just the truth-critical subset.
- **Headline reconciliation:** **correct the docs to measured reality** (no tuning the attack to fit the marketing).

### 2.6 Execution + verification evidence
8 phases, verified after each. Test trajectory: **Python 41 → 77**, **Foundry 15 → 32**. On-chain round trip (`make anvil` + `onchain_demo.py`) re-verified: EIP-712 signed prints post → verify on-chain → read back byte-identical → future settles. Eval gate passes with margin (§6).

---

## 3. Session 2 — real Circle/Arc live-wiring (deep dive)

### 3.1 Starting surface (what an Explore map found)
Every Circle/Arc primitive was either accounting-only or a dev-mode stub: `x402.py` `Facilitator.verify` parsed a string (`"x402 <payer>:<amount>"`), signing used a raw in-process `Account.from_key`, `arc_source.py` had an **invented** `AuthorizationUsed(from,to,value,size,service,ts)` ABI (not real EIP-3009), and there was no Circle SDK, wallet, paymaster, or EIP-3009 settlement anywhere. The seams were clean, though — all isolated behind offline-tolerant interfaces, with `web3`/`eth-account`/`httpx` already available.

### 3.2 User scope decisions (Session 2)
- **Depth:** **full live wiring** (real code paths targeting Circle sandbox + Arc testnet, unit-tested with mocked Circle responses; needs the user's creds to run live).
- **Primitives:** **Nanopayments/x402 + Circle Wallets + Arc-live/Circle-Contracts.** **Paymaster OUT** — because Arc USDC is the native gas token, so gasless is intrinsic.

### 3.3 Design (the three seams)
- **`Signer`** (`oracle_client/signer.py`): `LocalKeySigner` (raw key, byte-identical default) / `CircleWalletSigner` (custody EIP-712 sign + contract-execution, lazy SDK). Chosen because **`ACROracle.postPrint` verifies the EIP-712 *signer*, not `msg.sender`** → a Circle wallet signs, any relayer submits, and the existing `sign_print`/`PostPayload`/`ORACLE_ABI` seams stay unchanged. The `Signer` both signs *and* submits so `CircleWalletSigner` can also pay Arc USDC gas.
- **`Facilitator`** (`services/index_api/x402.py`): base + `DevFacilitator` (mock, default) + `CircleFacilitator` (real x402 v2). Selected by config presence; fail-closed.
- **`ArcSource`** (`acr_tape/arc_source.py`): config-driven event decode. **Honesty note:** real EIP-3009 `AuthorizationUsed(address,bytes32)` carries **no value/size/service**; USDC value is in the ERC-20 `Transfer`; `size`/`service` aren't on-chain. So the decoder defaults to `Transfer`, derives `size` so `price` = the index reference level (recovers notional, fabricates no signal), and documents that the **authoritative** ACR tape is the facilitator's own settlement log.

**Hard invariant:** every path keeps the offline fallback — `make test` stays green with zero Circle env and without the Circle SDK installed (the SDK is a lazy, optional extra; tests inject fakes).

### 3.4 Execution + key discoveries
6 phases (P0 config/conftest → P1 signer → P2 facilitator → P3 ArcSource → P4 deploy → P5 docs). Test trajectory: **Python 77 → 100**. Key discoveries during build:
- **Circle Wallets can sign EIP-712 typed data directly** → maps cleanly onto `sign_print` (Circle signs the `Print`, any relayer submits).
- **The repo `.env` was polluted:** a copy of an early `.env.example` draft whose inline `# comments` after `=` parse as the *value* (e.g. `circle_wallet_id = "# the oracle…"`). This would have made path-selection think creds were present → added a hermetic root **`conftest.py`** that disables `.env` + strips `ACR_*` so tests never depend on a local `.env`. **A real live run still needs a clean `.env`.**

---

## 4. Decision record (ADR-style — fork → choice → why)

1. **Audit trust model** → verify every finding by reading source lines, not agent summaries. *Why:* "not just average execution"; agent scans can be plausible-but-wrong.
2. **Hardening scope** → full P0→P2 sweep. *Why:* user chose; the goal was genuine robustness, not a subset.
3. **Headline numbers** → correct docs to measured reality. *Why:* user chose; honest under hostile Q&A beats fitting the attack to the marketing.
4. **Cap-aware bound** → exact analytic accounting (not fully-empirical). *Why:* `clean()` ≈ 0.11s × ~200 evals = 10–30s/print, too slow; the evading-adversary structure lets the cap→cluster/identity count be computed in closed form. Validated empirically by `redteam/optimal_attack.py`.
5. **Store refresh** → rolling window over the fixed 24h tape (not re-simulate a longer horizon). *Why:* the simulator's RNG draw order is horizon-dependent, so re-sim isn't determinism-extendable; windowing reuses the pattern already in `attack.py`/`eval.py`.
6. **Circle scope** → full live wiring, Paymaster out. *Why:* user chose; Arc USDC is the gas token, so ERC-4337 is redundant.
7. **Signer** → one interface that signs *and* submits; poster path = Circle EIP-712 sign + any relayer submits. *Why:* `postPrint` verifies the signer not `msg.sender`, so custody-sign + relayer-submit is the natural, key-safe design.
8. **Circle SDK dependency** → optional extra (`[project.optional-dependencies].circle`), lazy-imported only when no client is injected. *Why:* keeps the default env lean and CI credential-/SDK-free while giving a one-flag (`uv sync --extra circle`) live path.
9. **Test hermeticity** → root `conftest.py` disables `.env` + strips `ACR_*`. *Why:* a developer's local `.env` must never change test outcomes.

---

## 5. Research reference — Circle/Arc API facts (with sources)

These were gathered via web research and are the reusable reference the code is built against. Confirm the "Flags" (§7) against live Circle docs before a production run.

### Arc testnet
- Chain id **5042002**; RPC **`https://rpc.testnet.arc.network`**; CAIP-2 **`eip155:5042002`**; explorer **testnet.arcscan.app**.
- **USDC is a native system contract** at **`0x3600000000000000000000000000000000000000`** and is the **gas token** (unlike other chains where USDC is a regular ERC-20). ⇒ gasless UX is intrinsic; no ERC-4337 paymaster needed.
- Sources: `thirdweb.com/arc-testnet`, `docs.arc.io/arc/references/contract-addresses`, `alchemy.com/rpc/arc-testnet`.

### x402 v2 protocol
- Headers: **`PAYMENT-REQUIRED`** (server→client, base64 PaymentRequirements), **`PAYMENT-SIGNATURE`** (client→server, base64 PaymentPayload), **`PAYMENT-RESPONSE`**.
- Schemes: **`exact`** (EIP-3009 `TransferWithAuthorization`, fixed amount), `upto`, `batch-settlement`. Network in CAIP-2. PaymentRequirements fields: `scheme, network, asset, payTo, maxAmountRequired, resource, description, mimeType, maxTimeoutSeconds, extra`.
- Circle **Nanopayments** = the `exact` scheme with EIP-3009 against the **`GatewayWalletBatched`** domain (gasless from the buyer's Gateway balance, batched net settlement). A **facilitator** exposes `POST /verify` + `POST /settle` taking `{paymentPayload, paymentRequirements}` → `{isValid}` / `{success, txHash}`; the Gateway-batched middleware needs **no Circle API key** (the GatewayWallet contract handles it).
- Sources: `github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md`, `developers.circle.com/gateway/nanopayments/concepts/x402`, `circle.com/nanopayments`.

### Circle Developer-Controlled Wallets
- Python SDK **`circle-developer-controlled-wallets`** (PyPI; `from circle.web3 import developer_controlled_wallets`); Node **`@circle-fin/developer-controlled-wallets`**.
- Auth: **`CIRCLE_API_KEY`** (`PREFIX:ID:SECRET`) + a 32-byte-hex **entity secret** (the SDK RSA-encrypts a fresh *ciphertext* per request).
- Capabilities: **EIP-712 typed-data signing**, EIP-191, raw-tx signing, and **contract execution** (`walletId, contractAddress, abiFunctionSignature|callData, abiParameters, feeLevel, idempotencyKey` UUIDv4). Account types EOA or SCA. **Arc is a supported chain.**
- Sources: `developers.circle.com/wallets/dev-controlled`, `pypi.org/project/circle-developer-controlled-wallets`, `github.com/circlefin/skills` (use-developer-controlled-wallets).

### Circle Smart Contract Platform ("Circle Contracts")
- Deploy by **ABI + bytecode** (or a template), or **import** an existing contract by address + blockchain; uses developer-controlled wallets + Gas Station. SDK `@circle-fin/smart-contract-platform`.
- Source: `developers.circle.com/contracts`, `developers.circle.com/api-reference/contracts/smart-contract-platform/deploy-contract`.

---

## 6. Verification evidence (measured, not aspirational)

**Headline resistance (the numbers now gated in CI):**
- **Paired 1h demo** (seed 11, $8k budget): VWAP dragged **110.8% / 107.1% / 122.5%** (INF/GPU/DATA); ACR moved **+0.20% / −1.02% / +2.39%**; resistance **562× / 105× / 51×**.
- **12h eval series** (seed 21): attack-window VWAP err **5703.9 bp (~57%)** vs ACR **124.1 bp (~1.24%)** → **~46×**; quiet-hour ACR err ~73 bp.
- Gate thresholds (measured minus margin): attack ACR err < 300 bp, attack VWAP err > 4000 bp, ratio ≥ 20×, quiet ACR err < 300 bp — enforced by `eval.py --check` + `tests/test_claims.py`.

**Test-count trajectory:** Python **41 → 77 → 100** (98 pass + 2 anvil-gated skips); Foundry **15 → 32**; `ruff` clean.

**On-chain round trip** (`onchain_demo.py` on anvil): deploy → 3 sellers attest + read back → EIP-712 signed prints post + read back byte-identical → `isStale`/age line → ACR-Weekly future cash-settles. Re-verified after both sessions.

---

## 7. Open questions / Flags (confirm against Circle docs before live; each config-isolated)

| Unknown | One-line fix point |
|---|---|
| Circle Gateway facilitator **base URL** | `ACR_X402_FACILITATOR_URL` |
| `/verify` `/settle` **JSON field names** (`isValid`/`success`/`txHash`) | `CircleFacilitator._parse_verify` / `_parse_settle` |
| PaymentRequirements **`extra`** for GatewayWalletBatched | built from `x402_scheme` + `usdc_address`; overridable |
| Circle **SDK method names** (typed-data sign, contract-execution, poll) | `_RealCircleClient` / `_RealCircleDeployer` adapters (lazy) |
| Real **Arc event signature** + `size`/`service` derivation | `ArcSource.event_abi` / `field_map` / `service_resolver` |
| Entity-secret registration + wallet `accountType` (EOA/SCA) on Arc | `.env.example` note + `--import-by-address` |

Also open: no git commits yet; the repo `.env` needs re-copying from the fixed `.env.example` before a live run.

---

## 8. How this was built (working method — continue in this discipline)

- **Parallel `Explore` audits** to map breadth fast, then **firsthand source reads** to verify every finding before changing it (never trust a scan for a load-bearing claim).
- **`Plan` sub-agents** to design remediation/integration; the user chose scope at genuine forks via focused questions.
- **Adversarial verification** of claims: the eval gate and `redteam/optimal_attack.py` *execute* the attack the bound prices, rather than asserting it in prose.
- **Hermetic, offline-tolerant** engineering: absence of config selects the safe/dev path everywhere; the SDK is lazy-optional; a root `conftest.py` keeps tests independent of any local `.env`. `make test` is credential-free.
- **Measured, not aspirational:** docs state the numbers the code actually produces, and CI gates them below reality with margin.

Keep these invariants (see STATUS §"decisions not to undo") and the codebase stays honest.

---

## 9. Session — the Public Desk's first real transactions (2026-08-01)

The desk (commit `89e96d4`) shipped fully written and **never once exercised**:
no faucet ledger on disk, no tx hash anywhere, hermetic tests only. The spike
script had verified session creation and `user/initialize` and explicitly
deferred "the PIN ceremony + the gasless-trade check" to a browser step that
never happened. This session ran that step for real. Evidence and the operator
sequence live in [`TESTNET_RUNBOOK.md`](TESTNET_RUNBOOK.md) §5b.

### What was actually broken (found by running it, not by reading it)

1. **`ACR_FUTURES_ADDRESS` was absent from `.env`** (and `ACR_ORACLE_ADDRESS`
   was blank) — every `/desk/challenge` 503'd before touching Circle. The
   single largest blocker was a missing config line.
2. **Lowercase addresses.** Circle returns them; web3 refuses a non-checksum
   address and `FuturesClient` swallows that as `None`, which surfaces as "the
   venue is not reading right now". It looked exactly like RPC throttling and
   wasn't. Fixed at the boundary (`desk._checksum`).
3. **The faucet could only ever time out.** Circle's confirm poll runs up to
   120s; the terminal's proxy aborts at 20s. Worse, the timeout left the
   address's one-and-only drip slot consumed. Now the slot is claimed
   synchronously (the cap stays honest) and the transfer confirms on a daemon
   thread; the client watches its balance instead.
4. **The wallet SDK's completion callback is not reliable.** Observed twice:
   the transaction completed (Circle `COMPLETE`, event on-chain) and the
   callback never fired, hanging the desk forever on an action that had
   *succeeded*. The desk now treats the venue as the source of truth —
   `executeChallenge` resolves on a timeout as well as the callback, and each
   step confirms against `/desk/limits` before advancing.
5. **"BUY 1" was unpayable.** At a 0.4977 mark on a 10× index, one contract
   needs ~0.9955 USDC of initial margin — twice the whole faucet stake. The
   button would have reverted `taker margin` *after* the reader entered their
   PIN. The server now computes the feasible size from the live mark against
   **both** margin checks (the taker's and the auto-mirrored maker's) and the
   UI offers exactly that. The first live trade was `BUY 0.46`.

### Facts established, that had only been assumed

- **Gas Station sponsorship is real** for these SCAs on Arc Testnet. The
  authority is the ERC-4337 `UserOperationEvent`'s `paymaster` topic, not
  Circle's `networkFee` — the fee is non-zero on every desk operation and the
  wallet is still debited nothing. An early draft of `desk_evidence.py`
  concluded "NO — the wallet paid its own gas" from the fee alone; the balance
  arithmetic (0.5 in, 0.5 posted, 0.0 left) contradicted it, and the paymaster
  field settled it. **Do not reintroduce the fee-based heuristic.**
- Circle's hosted PIN flow has a screen that gates Continue behind literally
  typing **"I agree"**. Automation stalls there silently — it was the reason
  three full ceremony runs died at "Confirmation" with a disabled button.
- The PIN inputs are `maxlength=1` and auto-advance on **keystrokes**;
  Playwright's `fill()` sets values without triggering that and does nothing.

### Landmine noted

Running `make api` locally with `ACR_POSTER_PRIVATE_KEY` set makes the **local**
box post oracle prints on its own timer, spending real testnet USDC from the
poster EOA — which is also the futures **maker**. A few hours of local dev
drained it to 0.007 USDC and prod prints started failing `insufficient funds`.
Refilled from custody (`0x8170d08b…`). For local work either blank the key or
raise `ACR_REFRESH_SECONDS`.

---

## 10. Session — arming the automation, and the chokepoints nobody could see (2026-08-02)

Three defects found by looking at the running system rather than the code. None
of them could fail a test, and all three made the product worse for a visitor
than for its author.

### The scheduled jobs had never run. Not once.

`futures-heartbeat.yml` and `futures-lifecycle.yml` lived on
`feat/onchain-futures`. **GitHub schedules `cron` exclusively from the default
branch**, and `main` carried only `ci.yml` and `keepalive.yml`. `gh run list`
showed days of keepalive and CI runs and zero heartbeat runs, ever. The "24/7
living book" was alive only while somebody ran the loop on a laptop — on-chain,
series 1 had a maker position and *no taker collateral at all*.

Merging PR #1 is what armed them; nothing else could have. The first dispatched
run then exercised a path that had never executed with the real key: the taker
found no collateral on the new series (a roll strands it on the retired one),
posted its own 3.00 USDC, and traded `BUY 1 @ 0.49773`.

**The general lesson:** a workflow file on a feature branch is not a scheduled
job, it is a *proposal* for one. Test that a cron fires by finding its runs, not
by reading its cron line.

The first genuinely *scheduled* run then arrived — for the `21:00` slot, at
`21:51`. Free-tier cron is delayed by tens of minutes and that is normal; do not
read a missing run in the first half hour as a broken schedule. It also went
**red** on one `429 Too Many Requests` from Arc's public RPC, because `--once`
broke out of the loop on the first exception having traded nothing. `--once`
means "land one fill", not "make at most one attempt": as written, the heartbeat
would have failed most hours for an entirely transient reason, and a heartbeat
that cries wolf hourly teaches everyone to ignore it — which costs more than the
outage it exists to announce. It now retries `LOOP_ONCE_ATTEMPTS` (5) times with
the escalating backoff already present. The rule that a beat which traded
nothing must exit non-zero is untouched; the point was to make the signal
trustworthy, not to soften it.

Worth noting what worked: that `done == 0 → exit 1` guard, added in the previous
session, is the only reason this was visible at all. Without it the run would
have gone green having done nothing.

### The rate limiter rationed the whole world to one bucket

Every reader reaches the desk through a server-side Next.js proxy, so the
`X-Forwarded-For` the seller sees is a **Vercel edge IP** — the same one for
every visitor on earth. Keyed on that, "5 sessions and 3 faucet drips per hour"
was never a per-person limit; it was a global one. The sixth person to open the
desk in an hour would have been told "the desk is busy" by a desk sitting idle,
and a single tester can never observe it.

Now the **identity** bucket (desk user id, hashed session token, wallet address)
is the per-person limit, and the **host** bucket is a runaway guard sized for a
shared proxy. Raising the host ceiling is safe because that counter was never
what protected the custody wallet — `FaucetLedger.claim`, the global cap and the
reserve floor are — and it now sits deliberately *above* the ledger cap so the
ledger is what says no, honestly.

While there: `client_key` took the **left-most** forwarded hop, which is the one
the caller types. On a public host that let an abuser mint a fresh bucket per
request. It takes the right-most non-private hop now.

### A cold desk read took 55 seconds against a 28-second budget

Measured, not inferred: the first `/desk/limits` after an idle gap took
**55.24s** and `/desk/withdrawable` 9.64s, so the proxy gave up and the desk
reported itself down while it was up. Two causes.

`FuturesReader.read_all` called `read_desk` per index and every `read_desk`
began by scanning **all** series — the venue was scanned three times to produce
one desk, about eighteen sequential `eth_call`s. And the loop that warms those
caches also posts an oracle print, which spends gas, so production runs it
hourly (`ACR_REFRESH_SECONDS=3600`) while the caches live 90 seconds — cold for
~58 minutes of every hour. Reads cost nothing but RPC, so they got their own
short timer (`ACR_CHAIN_WARM_SECONDS`).

| path | before (prod, cold) | after (uncached) |
|---|---|---|
| `/desk/limits` | 55.24s | 8.17s median · 11.87s worst |
| `/desk/withdrawable` | 9.64s | 6.20s median · 8.55s worst |

**A measurement that reversed a decision.** The obvious fix — issue the
independent calls concurrently — was tested rather than assumed. Interleaved A/B
against Arc:

    fanout=1   median 3.0s        p90 12.2s
    fanout=4   median 1.3-4.1s    p90 30.8s

The median is a coin flip; the tail is not. Concurrency raises the odds of a
429, and every 429 costs a retry backoff measured in seconds. Behind a 28s
budget the tail is the number that decides whether a reader sees the desk, so
the default is **serial** (`ACR_RPC_FANOUT`). The real win was doing *fewer*
calls, not doing them at once. Single samples had said the opposite twice, in
both directions — this endpoint's variance is wide enough to fabricate any
conclusion you go looking for.

### A just-booted host skipped the faucet's fail-closed check

CI failed two ledger tests that pass on a laptop, and the difference was
**uptime**. `time.monotonic()` counts from host boot on Linux, so on a fresh
machine it returns a small number, and a staleness check written as
`now - hydrated_at < TTL` against an initial `0.0` reads as "hydrated moments
ago". For the first ten minutes of a container's life the ledger skipped its
fail-closed hydration from Circle — exactly the window after a restart when the
in-memory record is empty and that check is the only thing between an
already-paid address and a second drip. The durable ledger was added to close
that hole; on every fresh boot it was open again.

`None` now means never hydrated, and never hydrated is never fresh. The test
pins the clock to four seconds of uptime.

### The keys that run the book had no exit

The desk gives a *reader* an exit; the project's own keys had none, for the same
reason readers need one — collateral is **per series**, so a roll strands a stake
where nothing trades and nothing reclaims it. The heartbeat taker had 6.096010
USDC sitting in settled series 0 exactly that way.

`scripts/futures_withdraw.py` sizes the withdrawal with the *same* function the
desk quotes to readers, so a run is also a check on the product: if the two ever
disagree about what is free, one of them is lying to somebody about their money.
Recovered by `futures-recover.yml` (dispatch-only, dry by default) with all four
witnesses agreeing — contract `6096010 → 0` units, venue `11.051299 → 4.955289`,
wallet `8.629074 → 14.723416`, and a `CollateralWithdrawn` event for `6096010`.
Tx `0x09264fc62a69be7394f8a962dce84a5f393115bc7c4dca64e38ed5718bce1875`.

The dry run also earned its keep: unfiltered it would have pulled 1.904305 USDC
of *working* collateral out of the live series as well.

### The live tape was blank 39% of the time, and the archive showed a dead series

Once the automation was up, the public surfaces were checked rather than
assumed. Two things were wrong, and the fix for the first is not the obvious one.

**The heartbeat is not hourly.** Both the Python tape client and its TypeScript
mirror sized their log window on the belief that it is — each comment said 10k
blocks was "deep enough that the tape still shows the hourly heartbeat's last
fill". GitHub free-tier *drops* scheduled ticks: the observed gaps were 59m,
63m, **150m and 209m**. Arc's block time measures **0.510s**, so 10k blocks is
1.42h of tape. Replaying the real tick times against that window puts the public
tape at **empty 39.2% of the time** — a "living market" blank two hours in five.

**The window cannot simply be widened.** Arc hard-caps an `eth_getLogs` range,
and it is a *range* limit rather than a response-size limit — 20000, 40000 and
100000 blocks are all refused with HTTP 413 no matter how few logs match. Binary
search against the live RPC puts the cap between **14843 and 15000 blocks**
(~2.10h). Raising the constant would therefore fail on every call and silently
degrade to the fallback rung: identical coverage, plus a wasted round trip. The
tape has to be **paged** — four pages of 14000 blocks, ~7.9h of reach.

**And paging exposed a bug that had been hiding in the fallback ladder.** The
first attempt still returned one fill, in 16.6s. The ladder narrows the range on
*any* exception — but Arc answers throttling with **429**, where a narrower
range is no cure at all: the request was never too big, there were merely too
many of them. So a throttled page fell through every rung, each one failing for
a reason narrowing could not fix, and advanced the cursor by 300 blocks instead
of 14000. A four-page 7.9h walk collapsed to 1264 blocks while paying full retry
backoff to go nowhere. `_is_range_error` now separates "the node refused the
size of the range" from "the node refused *us*"; only the former shrinks, and a
throttle stops paging and keeps what it has. Measured after: **1 fill → 3 fills,
reaching 6.20h back**.

The first page is also allowed more retries than the rest, because the first
page *is* the tape and the others are only depth — a shorter tape now beats a
complete one a minute from now.

Because the tape walk is the most expensive read the desk serves and sits on
`/futures`, the endpoint the venue's liveness is judged by, it joined the
background warm and its cache TTL went 30s → 90s to outlive the warm interval.

**The bundle was stale.** `fallback.json` still described series 0 as
`settled: false` with `open_interest: 3.0` — a series that had settled ten hours
earlier — on the tier served when everything else is down, which is the one a
judge on a cold free-tier box is likeliest to hit. Regenerated: series 1,
unsettled, +155.6h, and 3 real fills instead of 1 (the paging fix flows into the
snapshot, which uses the same client).
