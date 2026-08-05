# The Arc Compute Rate — Methodology

### A manipulation-resistant benchmark family for machine commerce

> **Status:** working paper (v0.1). The methodology *is* the product — published
> before liquidity, the way SOFR was designed before it had a derivatives market.
> This document specifies the estimand, the estimator, and the manipulation
> bound precisely enough to be reproduced from the reference implementation in
> this repository.

---

## 1. The estimand

Let \(p^\*_t\) denote the **latent price of a machine service** — the constant-quality
dollar rate a buyer would pay for one unit of inference (\$/1k tokens), GPU time
(\$/GPU-sec), or served data (\$/MB) at economic time \(t\). This is never observed
directly. What is observed is *payment exhaust*: a stream of x402 authorizations
and Gateway settlements. ACR is the estimator \(\widehat{p}_t\) of \(p^\*_t\),
published hourly as an on-chain reference rate.

The single discipline of the system: **one estimand.** Every stage below is
justified by whether it reduces the bias or variance of \(\widehat{p}_t\) as an
estimate of \(p^\*_t\) — not by whether it produces a nice-looking dashboard.

## 2. The observation model (Pillar 1)

The observed tape is not \(p^\*_t\). Two distortions sit between them.

**Batching.** Circle Gateway settles *net* positions on a schedule. A trade's
economic time and its settlement time differ, and many trades collapse into one
settlement slot. Formally the observed tape is the latent process convolved with
the batching operator \(H\) (a box average of width \(k =\) batch interval / bar
step) plus noise:
\[
 y_t = H\,x_{t-k+1:t} + v_t, \qquad x_t = x_{t-1} + w_t,
\]
where \(x_t = \log p^\*_t\) follows a local-level (random-walk) law. A naive VWAP
over settlement time measures \(H\) — the scheduler — not \(x\).

**Recovery.** We write this as a linear-Gaussian state space whose state carries
the last \(k\) latent values, so \(H\) is a *known* measurement map, and run a
Kalman filter + RTS smoother to invert it. The smoother output \(\hat{x}_t\) is
the deconvolved latent estimate. See `acr_estimator/observation_model.py`.

*Why Arc:* Malachite's deterministic sub-second finality gives clean tick
timestamps — no reorg ambiguity in the tape, so the volume-time clock and the
known-\(H\) assumption are sound.

## 3. Cleaning (contamination model)

The estimator assumes contaminated data, not clean data. On the funding graph
(nodes = addresses, edges = USDC notional) we exclude:

1. **self-dealing** — buyer = seller;
2. **wash cycles** — reciprocal funding (A→B and B→A): a ring with ~zero net flow
   but non-zero printed volume;
3. **sybil clusters** — small, self-contained Louvain communities whose *internal*
   share of touched notional \(I_c/(I_c+B_c)\) exceeds `SYBIL_INTERNAL_RATIO`
   (each edge counted once — a community trading half externally scores 0.5, below
   the threshold);
4. **cluster caps** — no community contributes more than a fixed fraction \(c\) of
   window weight, attributed on **both** the buyer and seller side so a buyer
   cluster funnelling flow through many sellers is capped too.

Output is a per-event weight vector (zeroed for excluded flow, scaled for capped
clusters). See `acr_estimator/cleaning.py`. The reference red-team adversary
(`acr_sim/adversary.py`) deliberately emits all three excludable shapes —
self-deals, on-tape reciprocal funding legs, and a pure-sybil ring — so every
defense is exercised; on the default attack it neutralizes ~100% of injected wash
weight before estimation (`test_cleaning.py`).

## 4. Robust estimation

On the cleaned, quality-adjusted observations we compute the **volume-time
\(\alpha\)-trimmed weighted median**. A weighted mean (VWAP) is a broken statistic
here: it chases whichever cluster prints the most volume — the adversary's lever.
The trimmed weighted median has:

- **breakdown point \(1/2\)** against value corruption (inherited from the median;
  \(\alpha\) does not raise it but bounds gross-error sensitivity), and
- a per-actor influence bounded by the cluster caps of §3.

That second property is reported **per print**, not asserted in the abstract:
`acr_estimator/robustness.py` attaches to every print the single-cluster flip
fraction \(c/(0.5(1-2\alpha))\) (< 1 ⇒ one capped cluster provably cannot move the
print), the largest surviving community's share, and the empirical
leave-one-community-out shift of the median in basis points. One caveat on the
last of these: on a window where **all** surviving flow lands in a single
community, `max_cluster_influence_bp` reads `0.0` by *absence of a comparison* —
there is no second community to re-median against — not by demonstrated
robustness. Read it alongside the sybil-zeroing stage, which is the
load-bearing defense on such windows (see `IMPLEMENTATION_STATUS.md` on why the
cap contributes ~0 to stability).

Each print ships a **weighted-bootstrap confidence interval**: resample by weight,
recompute the trimmed median, take empirical quantiles. The Pillar-1 smoother
(§2) contributes a shrunk end-of-window displacement whose posterior variance
flows into the interval — the CI reflects deconvolution uncertainty rather than
being silently widened. See `acr_estimator/robust.py` and `pipeline.py`.

## 5. Hedonic adjustment (Pillar 2)

Observed prices mix the market level with the *quality mix* of who traded
(frontier vs open model, tight vs loose latency SLO). We regress
\(\log p\) on quality features from the on-chain attestations and re-price every
observation to a single reference quality (MID class, 250 ms):
\[
 \log p^{\text{adj}} = \log p - \beta\cdot(x - x_{\text{ref}}).
\]
The resulting **constant-quality** series (Case-Shiller methodology for compute)
moves only when the market moves, not when the trade mix does. Quality features
come from `AttestationRegistry.sol` — the flywheel: attest better metadata → be
priced fairly → win flow. See `acr_estimator/hedonic.py`.

## 6. The manipulation cost bound (Pillar 3)

For each print we compute the minimal *surviving* wash notional \(N^\*\) that moves
the trimmed weighted median by a target amount, numerically, on the actual cleaned
distribution — then price it against the **only adversary that can get mass past
the cleaning stack**: a cleaning-evading sybil (fresh identities disjoint from the
honest graph, clusters larger than `SYBIL_MAX_SIZE` to dodge the small-cluster
test, one-directional so no reciprocal edge, unattested so the hedonic adjustment
is identity). The cluster cap then enters as a *count*: injecting \(N^\*\) needs
\(m=\lceil N^\*/(c\,(\text{raw}+N^\*))\rceil\) distinct clusters, i.e.
\(m\,(\texttt{SYBIL\_MAX\_SIZE}+1)\) funded identities. Priced through Arc's
**deterministic USDC fee schedule**, including the reverse funding leg each
identity needs:
\[
 \text{cost} = 2N^\*\cdot(\text{fee}_{bp}\cdot 10^{-4}) + (N^\*/\text{trade} + \text{identities})\cdot\text{fee}_{\text{flat}}.
\]
Because the fee is a fixed constant on Arc, `cost` is a **number**; on a
volatile-gas chain it is a distribution — *only computable on Arc*. Reported
per-bp (a marginal lower bound) and per-1% (the quotable figure), each with the
implied cluster/identity count. `redteam/optimal_attack.py` executes this exact
attack through the full cleaning stack, verifying the bound is attainable and not
loose. See `acr_estimator/bound.py`.

> **Follow-up (not yet implemented):** the cap is a fraction of *raw* window
> volume; keying it off *surviving* volume would tighten the bound further. The
> number here models the cap rule as implemented.

## 7. On-chain publication & settlement

`ACROracle.sol` stores each print — value, CI, and attack-cost bound together —
authenticated by an **EIP-712 signature** over the `Print` struct (domain
`ACR Oracle` v1): an authorized signer signs, and *any* relayer may submit via
`postPrint`, which verifies the recovered signer on-chain. The contract enforces
the benchmark invariants: value within CI, positive bound, strictly monotone
economic timestamps, and an economic timestamp no more than `MAX_TS_SKEW` ahead of
block time (so a fat-fingered far-future timestamp reverts instead of permanently
bricking the feed). Consumers get freshness via `isStale(id, maxAge)` /
`latestPrintWithAge` before settling. The owner can pause posting and rotate
signers; ownership transfer is two-step.

`AttestationRegistry.sol` holds the EIP-712 seller metadata feeding §5, with
per-seller nonces and a signature deadline so a captured `attestWithSig` cannot be
replayed to overwrite newer metadata. A cash-settled **ACR-Weekly future** settles
against the oracle print (no delivery, no bonds), and an Avellaneda–Stoikov market
maker seeds the first term structure. See `contracts/` and `acr_instrument/`.

*Live wiring (Circle/Arc):* prints are signed by a raw key **or** a Circle
Developer-Controlled wallet (custody), and the x402 gate settles through Circle's
Nanopayments facilitator (the `exact`/GatewayWalletBatched scheme over EIP-3009).
On Arc (chain id `5042002`) USDC is a native system contract *and* the gas token,
so payments and posts are gasless without an ERC-4337 paymaster — the manipulation
bound's deterministic-fee assumption (§6) is exactly this native-USDC property.
Everything degrades to the offline simulator when no credentials are set; see
`.env.example` and `IMPLEMENTATION.md`.

## 8. Evaluation

We validate on a calibrated simulator (`acr_sim`) with published parameters: an
OU latent level, a heterogeneous seller population with a known premium
structure, a Gateway batching operator, and a parameterized wash-flow adversary.
The headline metric is **naive-VWAP error vs ACR error under attack**, measured in
two seeded, reproducible scenarios (all figures below are the measured values, and
are enforced as CI gates — `scripts/eval.py --check` and `tests/test_claims.py`):

- **Paired 1-hour demo** ($8k wash budget, `scripts/run_demo.py`): naive VWAP is
  dragged **>100%** (measured 107–123% across the three indices) while ACR moves
  **<3%** (measured 0.2–2.4%) — a **50–560×** resistance ratio.
- **12-hour eval series** (`scripts/eval.py`): in the attack window naive VWAP
  errs **~57%** (5700 bp) vs ACR **~1.2%** (124 bp) — a **~46×** ratio; quiet-hour
  ACR error is **<1%**.

The gate thresholds (attack ACR error < 300 bp, VWAP error > 4000 bp, ratio ≥ 20×)
sit below the measured numbers with margin, so the claims cannot silently drift
from the code. The attacker's spend is reported next to the move.

The same estimator runs, byte-for-byte, on real Arc testnet flow via
`acr_tape.ArcSource`; methodology-first, liquidity-second.

---

*ACR — one estimand, four pillars, ten arrows. The rate machine commerce settles on.*
