# ACR — the questions, both directions

**Part I** is what ACR asks Circle. **Part II** is what ACR has to answer:
the estimand, the manipulation bound, what is real and what is simulated, and
the sharpest attack on each claim.

Part II follows one rule, and it is the rule the codebase already follows:
**every claim carries its evidence and its weakest point.** `scripts/tape_audit.py`
exists because "real on-chain flow carries no compute-price signal" was too
load-bearing to leave as prose — so it is measured instead. This document is
written the same way. If you are reading it to prepare for a hostile question,
the answer you need is next to the claim, not in a caveats appendix.

Numbers here were re-measured against production on **2026-08-04**; each one
says how to re-measure it, because the docs are the thing that drifts.

---

# Part I — what we ask Circle

> Session: Ignyte × Circle × Arc live build on autonomous agents (Agent Stack,
> Gateway/x402 nanopayments, wallet guardrails, open Q&A).
> Position to open from: **we're not asking how to start — every rail on your
> agenda already runs in our production stack.** 7 real Gateway x402
> settlements on a public ledger, a live cash-settled futures venue on Arc,
> readers trading through Circle user-controlled SCA wallets from a browser,
> paymaster-sponsored gas, custody-signed hourly oracle prints, and measured
> numbers on Arc's RPC edges.

---

## Tier 1 — the five headline questions (ask no matter what)

### Q1. Platform-enforced spend policies for agent-held wallets

> "Our buyer agent settles real x402 payments autonomously, but its only
> guardrail is a client-side spend cap in its own code, and its key lives in
> CI secrets. Does the Agent Stack support **declarative, platform-enforced
> policies** on developer-controlled wallets — per-resource caps, velocity
> limits, counterparty allowlists — so an agent can hold signing power but
> *physically cannot* overspend, even if its code is wrong?"

- **Why it wins:** "the agent's budget is enforced by the platform, not by
  the agent's own honesty" is *the* unsolved problem of autonomous payments —
  and we hit it in production, not in a slide.
- **If yes, we ship:** maker/taker/buyer keys move into Circle custody under
  policy; the raw-EOA-in-secrets model is retired. Pitch line: *no private
  key exists in our repo, anywhere.*

### Q2. Delegated autonomy on user-controlled wallets — the auto-hedger

> "On our Public Desk, humans open Circle user-controlled SCA wallets via the
> PIN ceremony and trade our compute futures. Can a user grant a
> **time-boxed, amount-boxed session credential** so an agent trades *on
> their behalf* — 'hedge my compute bill, up to 10 USDC, this week' — without
> a PIN per transaction? What's the supported path on Arc today: session keys
> on the SCA, a policy-bound developer wallet per user, or roadmap?"

- **Why it wins:** this closes our deck's lead use case (the compute-cost
  hedger) end-to-end as an *autonomous* flow. Human sets a mandate once, the
  agent executes within it — human-delegated autonomy is rarer and more
  novel than human-absent autonomy.
- **If yes, we ship:** an "auto-hedger" mode on the Desk using whatever
  primitive they name. Even their fallback answer demos within the week.

### Q3. Arc is not in your own Discovery API — what is the path?

> "Your Discovery API serves **958 listings**, and every network in a 200-item
> sample is a mainnet chain — Base, Ethereum, Polygon, Avalanche, Arbitrum,
> Optimism, Unichain, Sonic, World Chain, Sei, Hyperliquid.
> `network=eip155:5042002` returns **zero**, and no Arc network appears
> anywhere. We meet every listing prerequisite — 402 when unpaid, we serve on
> payment, we publish an OpenAPI spec, and our payout wallet is a Circle
> developer-controlled wallet — so the only thing disqualifying us is the
> chain. **What is the path for an Arc service to become discoverable, and does
> it change when Arc mainnet lands?**"

**Why it wins:** it is a question only someone who ran the query can ask, and it
lands on a real gap in their own stack — the chain they built for agents is the
one their agent marketplace cannot index. Everyone else in the room will ask
"how do I get listed"; this asks "why can nothing on Arc be listed".

**Follow-ups worth having ready:**
- Your seller-integration-tools page points at Proceeds "on Arc and other
  blockchains" — is that the sanctioned route for Arc services today, and does
  it cover testnet?

  > **Measured 2026-08-04 — half-answered, and the remaining half is sharper.**
  > Technically yes: their management API
  > (<https://myproceeds.xyz/api/openapi.yaml>) carries **`arc-testnet`** as a
  > first-class `NetworkId`, accepts a `mode: testnet` service, and its
  > `Transaction.scheme` even includes **`nano` — "Circle Gateway batching"**.
  > But Proceeds is a **paying proxy**: the buyer pays *them*, and they call my
  > origin carrying a static bearer token from the service's `authConfig`. So
  > the real question is no longer "can an Arc service be listed" but **"is a
  > proxy the sanctioned shape?"** — because taking that route means my gate
  > admits a forwarded call on a shared secret instead of an on-chain
  > settlement, which is a strictly weaker guarantee than x402 settling to my
  > own wallet. Related: `PaywallCreate` has no `merchantWallet` field, so a new
  > paywall pays *their* embedded wallet until it is PATCHed — a default worth
  > flagging to any seller you point there. We declined the listing for those
  > reasons; ask this in the reply to the marketplace form.
- Is `x402Version: 2` a hard requirement for indexing? (Ours advertised 1 until
  we diffed against a live listing; nothing documented the version.)
- `FINANCIAL_ANALYSIS` carries 447 of the 958. Is the six-category taxonomy
  fixed, and how does a genuinely new category get added?

**What we ship either way:** our catalog now matches your item shape exactly —
`x402Version: 2`, `lastUpdated`, and a `metadata.provider` carrying the
`category`/`tags`/`website`/`docsUrl` your API filters on — verified by diffing
a built item against a live `FINANCIAL_ANALYSIS` listing. Plus the field no
other listing has: an on-chain attestation anchor, so a cautious agent can
require an attested seller before it pays.

### Q4. Pay-from-anywhere via Gateway's unified balance

> "Our payer deposited USDC into GatewayWalletBatched on Arc and settles
> there. Gateway's design is a **cross-chain unified USDC balance** — can a
> buyer holding testnet USDC on Base or Ethereum settle an x402 challenge
> whose seller expects Arc, with Gateway handling the rebalance? What's the
> supported chain set on testnet today?"

- **Why it wins:** it converts every judge into a potential live buyer —
  fund from whatever testnet USDC you already hold. And cross-chain/CCTP is
  the **only Circle rail ACR doesn't use yet** (verified: zero references in
  our code), so it's the final week's genuine expansion.
- **If yes, we ship:** a "fund from any chain" path for the buyer agent and
  Desk funding.

### Q5. Event push instead of log polling — with our measured numbers

> "We measured Arc's read path hard: `eth_getLogs` 413s above a ~15,000-block
> range, rejects a string `toBlock` (-32602), and 429-throttles aggressively —
> our tape reader pages 4 × 14,000 blocks and has to distinguish throttling
> from range errors, because backing off the range on a 429 silently
> destroys read reach. We already verify Circle webhooks for wallet events.
> Is there a supported **event-subscription / webhook path for Arc contract
> events**, or a higher-tier RPC / indexer for testnet?"

- **Why it wins:** nobody else in the room will have these numbers. It marks
  us as the team that found the platform's real edges — exactly the
  "integration issues" conversation they invited.
- **If yes, we ship:** the futures tape moves to push; the pager retires.

---

## Tier 2 — backups, one per theme (Q&A round two, hallway)

### Q6. The economic floor of nanopayments
At $0.0001/query, what does a Gateway settlement actually cost on your side —
and is **streaming / metered settlement** (pay-per-second data subscription
instead of a 402 round trip per request) on the roadmap? A metered channel
would make our index feed *subscribable* by an agent rather than re-bought
per query.

### Q7. Receipts as on-chain rights — ASKED, ANSWERED, SHIPPED ✅

**Asked at the session:** can a smart contract verify a Gateway settlement — an
attestation or signature checkable on-chain?

**Circle's answer:** *"For Gateway settlements, you'd need an EIP-712 signed
attestation or oracle receipt to cryptographically verify the off-chain x402
payment on-chain for the rebate."*

**So we built it, the same day.** `FeedAccessAttestor`
[`0xe671a8E7…`](https://testnet.arcscan.app/address/0xe671a8E73900F1186448cFFeA9e730F5E50DFD47)
on Arc: the seller signs a `FeedAccess` struct with the **same Circle custody
wallet that signs oracle prints**, anyone may relay it, and the contract
recovers the signer with `ecrecover` — exactly the pattern `ACROracle` already
uses, so the trust anchor is one a judge has already verified.

Proven live: the hedger's 3 settlements were attested to its smart account and
`hasFeedAccess(0x1Dc707E3…)` returns **true**. Off-chain revenue is now an
on-chain right.

The design decision worth defending: the seller **signs**, it does not
**decide**. Every attestation is derived from rows already public at
`/marketplace/receipts`, so it cannot mint access nobody paid for — that is what
makes the receipt worth believing rather than merely worth verifying. And
`payer` and `beneficiary` are separate fields because an x402 `exact` settlement
is signed by an EOA, so a Circle agent wallet pays from its backing EOA while
its smart account is what trades.

**Worth going back with:** is a first-party settlement attestation on Circle's
roadmap, so sellers do not each have to be their own oracle? Right now the
buyer has to trust the seller's signature about the seller's own revenue, which
is the one weak joint in this design.

### Q8. Agent identity + compliance mid-loop
We anchor seller reputation on-chain (ERC-8004-style attestations, surfaced
in the catalog). Is first-class **agent identity** — verifiable credentials
tied to wallets — planned? And operationally: what does a compliance flag
look like *to the agent* mid-loop — what should well-written agent code do
the moment its counterparty is frozen?

### Q9. Custody-signed market making
What are the real transaction-initiation latency and rate limits for
developer-controlled wallets on Arc? Our maker quotes on a per-minute loop
from a raw EOA because we assumed custody signing was too slow — if it's
~seconds, the maker's key moves into custody too (completing Q1).

### Q10. Paymaster policy and griefing
Our Desk users' gas is sponsored via the ERC-4337 paymaster. Can sponsorship
be **scoped** — contract allowlist, per-user budget, alerts? What stops a
griefer draining a sponsorship budget with junk userOps against our
contract?

### Q11. Arc mainnet
Timeline, and what carries over — contracts, Gateway, the paymaster — so our
"what's next" slide is accurate rather than hopeful.

---

## The integration-issues list to hand the Circle team

They asked for integration specifics. Each of these cost us real debugging
time; handing over a measured list is a credibility move:

1. Circle APIs return **lowercase addresses**; web3.py rejects
   non-checksummed input, and the failure presents as throttling, not as a
   format error.
2. The w3s SDK challenge callback **never fires on an already-COMPLETED
   challenge** — resuming a PIN ceremony needs a status poll, not the
   callback.
3. The hosted PIN flow gates on literally typing **"I agree"** —
   undocumented, and it stalls headless/E2E flows.
4. Gas sponsorship appears as an **ERC-4337 paymaster event topic**, not in
   the transaction's `networkFee` — fee accounting that reads the obvious
   field mis-reports sponsored transactions.
5. `eth_getLogs`: **~15,000-block hard cap** (413), string `toBlock`
   rejected (-32602), and 429 throttling that must never be treated as a
   range error (backing off the range on a throttle collapses read reach).

---

## Post-session build map (the final week)

| Answer unlocks | We ship |
|---|---|
| Q1 — platform policies exist | Custody-held agent keys with enforced budgets; raw keys deleted from secrets |
| Q2 — any delegation path | Auto-hedger mode on the Desk (the deck's lead use case, autonomous) |
| Q3 — an Arc path exists | Register wherever they name; watch the ledger for a THIRD payer — the only real proof of discovery |
| Q4 — unified balance spans chains | "Pay from any chain" for buyer + Desk funding |
| Q5 — event push exists | Tape via events; retire the getLogs pager |

**Regardless of their answers:**
- Attempt Q4 empirically — try a Base-testnet Gateway deposit against the
  Arc seller and measure what happens.
- Prototype the Q2 fallback (a developer-controlled wallet with a user-set
  budget cap) so the hedger demo exists even if session keys are roadmap.
- Merge the archive-path fix PR; keep the day-long print-gap measurement
  running to close out the heartbeat proof.

---
---

# Part II — what ACR has to answer

*Re-measured against production 2026-08-04. Every section names its own weakest
point; if one does not, it is incomplete.*

---

## §A — The thesis

### A1. Why does machine commerce need a benchmark at all?

Economies generally get a spot market first and a reference rate second, and
*standardised, nettable* hedging above spot is hard without one — bilateral GPU
forwards exist today, but they are bespoke contracts, not a market.
You cannot write "I will buy inference at 10% over the index in March" until
there is an index. Circle built the spot rails for machine payments; ACR is the
rate layer on top of them.

**The attack:** *"nobody is asking for this."* Correct, and unanswerable today —
see D4. The defence is structural rather than empirical, and should be stated as
a tendency rather than a law: LIBOR was standardised because an informal
quote-referencing market already existed, so the rate layer does sometimes
follow the trading it formalises.

### A2. Why can't Circle just publish this themselves?

Because a benchmark administered by the operator of the settlement rail is the
LIBOR failure mode, exactly. `Readme.md`: *"benchmark credibility requires
neutrality from the settlement-rail operator — the LIBOR lesson. The
administrator of the rate cannot be the operator of the rail."*

That is also the commercial argument: ACR is a partner to Circle rather than a
feature Circle would build.

**The rebuttal, and it uses our own hero against us:** SOFR is administered by
the New York Fed, which operates the repo plumbing; CME administers Term SOFR
while running the futures that settle on it; ICE administers LIBOR while running
ICE exchanges. So separation is a governance *preference*, not a law. The
defensible version is narrower: what benchmark regulation actually demands is
independent governance and an oversight committee — which a rail operator can
satisfy, and which ACR has not built either.

### A3. Isn't publishing a methodology before you have liquidity backwards?

It is the SOFR order. SOFR's methodology was specified, published and critiqued
before it had a derivatives market — the paper came first precisely so the
market that formed on top could trust the number. `docs/methodology.md` is
written as a working paper (v0.1) for that reason: *"the methodology **is** the
product — published before liquidity."*

**The attack:** SOFR had the Federal Reserve behind it and a mandate to replace
LIBOR. ACR has neither. The honest version of this claim is about *sequence*,
not authority: methodology-first is the right order, and it does not by itself
make anyone adopt you.

### A4. Why Arc — and is "testnet" the real answer?

This is the question worth being asked, because the dependency is mathematical,
not sentimental. On Arc, **USDC is the native gas token**, so the fee schedule
an attacker pays is a deterministic constant. That is what makes the
manipulation bound a *number*:

> `docs/methodology.md`: *"Because the fee is a fixed constant on Arc, `cost` is
> a **number**; on a volatile-gas chain it is a distribution — **only computable
> on Arc**."*

So the headline artifact of the product — a per-print cost-to-manipulate —
degrades into a random variable on any chain where gas floats. "Why Arc" has a
real answer; "why testnet" has a duller one (see D5): Arc mainnet does not exist
yet, and Circle's own marketplace indexes zero Arc services.

---

## §B — The estimator

### B1. What exactly is ACR estimating?

One estimand, stated precisely (`docs/methodology.md`):

> Let *p\*ₜ* denote the **latent price of a machine service** — the
> constant-quality dollar rate a buyer would pay for one unit of inference
> ($/1k tokens), GPU time ($/GPU-sec) or served data ($/MB) at economic time
> *t*. This is never observed directly. What is observed is **payment
> exhaust**. ACR is the estimator *p̂ₜ*.

And the discipline that follows from it: *"Every stage below is justified by
whether it reduces the bias or variance of p̂ₜ — not by whether it produces a
nice-looking dashboard."*

**The attack:** the estimand is unobservable by construction, so every accuracy
claim is measured against a **simulator whose latent path we chose**. The
estimator never sees the ground truth — that separation is enforced — but we
wrote both the truth and the estimator, and no external series exists to check
against.

### B2. Why isn't that just "the average price"?

Because two structural wedges sit between the exhaust and the price, and
averaging measures the wedge instead of the thing:

**The time wedge.** Circle Gateway settles *net* positions on a schedule, so a
trade's economic time and its settlement time differ and many trades collapse
into one slot. Written down, the observation is a box average of the latent
path. The consequence is blunt: *"a naive VWAP over settlement time measures
**H** — the scheduler — not **x**."*

**The composition wedge.** Observed prices mix the market level with the *quality
mix* of who happened to trade — frontier vs open model, tight vs loose latency
SLO. A raw average moves when the mix changes even though **no seller
repriced**.

**The attack:** both wedges come from a *model* of how the market works. If the
Gateway batch schedule is not what we assume, or quality is not captured by the
covariates we chose, then the correction is itself a distortion — and it would
be invisible, because we would still be comparing against our own simulator.

### B3. So what actually inverts them?

**Pillar 1 — Observation Model.** Rather than estimating the batching, the
estimator treats it as a *known* measurement map: the state is augmented into a
shift register so the box average becomes a known `H`, and a Kalman filter plus
RTS smoother inverts it. It is hand-rolled in numpy so the arithmetic is
auditable line by line. The file calls itself *"the stage no other team will
know exists."*

**Pillar 2 — Hedonic Adjustment.** Every trade is re-priced to one reference
quality (mid-class model, 250 ms SLO) by a notional-weighted regression on
attested covariates, so the resulting constant-quality series *"moves only when
the market moves, not when the trade mix does."* The covariates come from
`AttestationRegistry.sol`, which is the flywheel: attest better metadata → be
priced fairly → win flow.

**The attack on all of this:** the hedonic covariates are **self-attested and
unaudited**. A seller writes its own model class and latency SLO; nothing
verifies delivered quality against attested quality, and the attested-only mode
makes attestation *earn index inclusion* — which is exactly the incentive to
over-attest. Pillar 2 is only as good as the registry beneath it.

**Four unnumbered cleaning defenses**, one per adversary shape: self-dealing
(buyer == seller), wash cycles (reciprocal funding, a ring with ~zero net flow
but non-zero printed volume), sybil clusters (small Louvain communities whose
internal share of touched notional exceeds 0.6), and cluster caps (no community
contributes more than 5% of window weight, attributed on **both** sides — the
seller-only version missed a buyer cluster funnelling through many sellers).

> **A precision point worth getting right:** `docs/methodology.md` numbers only
> three — Observation Model (Pillar 1), Hedonic (2), Bound (3). Cleaning and
> robust estimation are deliberately *unnumbered* stages, and "Pillar 4 =
> Instrument" comes from `Readme.md` and the status docs rather than the
> methodology. If someone says "the four pillars", they are combining two
> sources. Distinct from, and easily confused with, **Circle's** five Agent
> Stack pillars in §E3.

### B4. Why a trimmed weighted median instead of a VWAP?

Because *"a weighted mean is a broken statistic here: it chases whichever cluster
prints the most volume — the adversary's lever."* The aggregator is a volume-time
α-trimmed weighted median, α = 0.10 per tail.

The statistical claim is stated carefully, which is unusual: breakdown point
**½** against value corruption, inherited from the median — *"α does not raise
it but bounds gross-error sensitivity."* And per-actor influence is reported
**per print** rather than asserted in the abstract: every print carries the
single-cluster flip fraction (0.125 — below 1, so one capped cluster provably
cannot move the print), the largest surviving community's share, and the
empirical leave-one-community-out shift in basis points.

### B5. What is the confidence interval, really?

A weighted bootstrap — resample by weight, recompute the trimmed median, take
the 95% empirical quantiles, 500 draws, fixed seed — log-shifted by the
smoother's shrunk end-of-window displacement and widened by that tilt's
posterior variance. So it *"propagates both sampling noise and weight
concentration: a fat-but-legitimate cluster widens the CI rather than silently
moving the point."*

**The attack, and it is fair.** It is the sampling variability of the estimator
over the cleaned, quality-adjusted observations in that window, plus
deconvolution uncertainty. It is **not** a bound on adversarial bias, **not**
model uncertainty over the hedonic specification, and **no empirical coverage
test exists anywhere in the suite** — nothing measures how often the interval
actually contains the simulator's known latent level. That is a real gap and it
is cheap to close.

### B6. What is hardcoded that ought to be estimated?

Volunteering these is better than being caught by them: the process and
observation variances are fixed constants rather than fitted; the deconvolution
tilt is hard-clipped to ±5% in log space; the batch width `k` is inferred from
an **assumed** 300-second Gateway batch interval, so if the real schedule
differs the "known `H`" claim weakens; and Louvain is stochastic — determinism
comes from a fixed seed, and a different seed can produce different communities
and therefore a different bound.

---

## §C — The manipulation bound

### C1. What is `attack_cost_per_bp`?

The USDC an adversary must burn to move a print by one basis point. It is
computed **per print**, on the actual cleaned distribution rather than from a
closed form: the minimal surviving injected mass `N*` is found by a 60-iteration
binary search, with the adversary's price placed just past the target so it
survives the trim, then priced against the only threat model that can get mass
through the stack — a **cleaning-evading sybil**.

That adversary is specified, not hand-waved: fresh identities disjoint from the
honest graph, clusters larger than the small-cluster threshold, no reciprocal or
self-deal edges, unattested (so the hedonic adjustment is identity), placed
inside the trim band. The cluster cap then bites through *count*, not fees —
each cluster may contribute at most 5% of window volume, so a large injection
needs many clusters and therefore many funded identities. *"Splitting is free in
fees but costs identities; that identity count is the cap's real bite."*

### C2. Is the number attainable, or just a formula?

Attainable, and the repo proves it by attacking itself. `redteam/optimal_attack.py`
constructs exactly the injection the bound prices, runs it through the **real
cleaning stack and the robust aggregator** — not the full pipeline; there is no
Kalman stage in this loop — and the test asserts both halves:

> at least half the injected weight survives cleaning, **and** the median
> actually moves by ≥ 1 bp.

That is the strongest single claim in the codebase — the published cost is
empirically reachable rather than a lower bound nobody has tried.

### C3. What are the live numbers, and are they impressive?

Read from the deployed `ACROracle` on 2026-08-04:

| Index | Value | Attack cost / bp |
|---|---|---|
| ACR-INF | 0.49112 | **0.005494 USDC** |
| ACR-GPU | 0.01083 | **0.006295 USDC** |
| ACR-DATA | 0.00203 | **0.008887 USDC** |

Re-measure with `curl .../onchain/ACR-INF`.

**Say the uncomfortable part first: these are sub-cent, and the repo's own
`cost_to_move_1pct` — a separate search, not 100× the number above — is about
1.0 USDC across all three indices.** They scale with window notional and the window is a testnet-scale
simulated tape. The novelty is not the magnitude — it is that the number
*exists per print*, is computed on real cleaned data, is empirically attainable,
and is a **contract invariant**: `ACROracle.sol` refuses to store a print whose
attack cost is zero. No rate *benchmark* — SOFR, LIBOR, Case-Shiller — ships a machine-computed
cost-to-manipulate inside the print itself. (Do not extend this to "any oracle":
UMA's DVM publishes a cost-of-corruption condition and Chainlink publishes
per-feed economic-security parameters. The narrow claim is the defensible one.)

### C4. What does the bound *not* cover?

- It is a **marginal lower bound**, cheapest near a dense median. A quant will
  divide `cost_to_move_1pct` by `cost_per_bp` and get less than 100 on two
  indices (measured on the press's own window, 2026-08-05: 171× ACR-INF,
  111× ACR-GPU, **65× ACR-DATA**) — and the decomposition explains it rather
  than excuses it. The 1bp price is dominated by a **fixed admission fee**:
  one evasion-sized sybil cluster is 41 funded identities ≈ 0.0041 USDC of
  flat transfers, which is 87% of INF's per-bp cost, 60% of GPU's, 37% of
  DATA's. The 1% attack pays that floor roughly once more (clusters go 1→2,
  not 1→100) while its cost turns ~98% proportional to wash notional. So the
  per-bp figure is a *marginal* price that includes the whole admission fee
  and the 1% figure is a *total* that amortizes it — expecting their ratio to
  be 100 is comparing a marginal price to an average one. The **notional**
  required is where superlinearity genuinely lives, and only near a dense
  median: moving INF 100× further takes **1,626×** the mass; DATA, whose
  median is far less dense, takes 102× — essentially linear. The attacker
  never escapes the floor; they just don't pay it a hundred times.
- It charges the attacker **only fees** — the wash notional itself is treated as
  free, because it round-trips inside their own identity set.
- It prices no identity-acquisition cost, no KYC, no opportunity cost of funds,
  no reputational cost.
- The cap denominator is loose by the methodology's own admission: it is a
  fraction of *raw* window volume, and keying it off *surviving* volume would
  tighten the bound. Flagged as a follow-up, not implemented.
- It bounds one estimator's sensitivity to one adversary class in one window. It
  says nothing about attestation gaming, oracle-key compromise, RPC censorship,
  or a persistent multi-window drift.
- The fee constants are configured, **not read from chain**.

### C5. What is the repo's own sharpest criticism of it?

This one, and it is better to say it than to have it found:

> `docs/IMPLEMENTATION_STATUS.md`: *"**Sybil-zeroing, not the cluster caps, is
> the real resistance.** Uniform cap-scaling of one honest community is
> median-invariant; the cap contributes ~0 to stability. This is *why* the bound
> models a sybil-flag-evading adversary."*

A related subtlety a careful reader will find: on a window where all surviving
flow lands in one community, the published `max_cluster_influence_bp: 0.0` is
zero by *absence of a comparison*, not by demonstrated robustness. Internally
consistent, easily misread — so state it.

---

## §D — Real, simulated, or first-party

*The section that decides whether the rest is believed.*

### D1. Is the published index computed from real economic flow?

**No, and that is a design decision that was measured rather than assumed.**

The estimator is real, the EIP-712 signature is real, the chain is real; the
*flow the number is computed from* is a calibrated simulator, labelled `sim`
everywhere it is served.

The reason used to be prose, and prose was too weak for the single most
load-bearing honesty claim in the project — so `scripts/tape_audit.py` measures
it. Run against live Arc on **2026-08-01** it read **16,339 real USDC
settlements over 20,000 blocks**, all landing on one index, with ACR-GPU and
ACR-DATA seeing **zero**.

Be precise about the "every one at the same price" part, because half of it is a
property of our own decoder: the legacy decode *recovers notional and fabricates
no price signal, exactly as designed*. The empirical findings are the volume,
the single index, and the two zeros. When no priced index can be produced its
verdict block reads:

> *"No index can be published from real Arc flow in this window. The simulated
> tape is not a convenience — it is the only source that produces a number, and
> the honest label on the published index is 'sim'."*

It exits 0 on purpose: *"a thin real tape is a finding to publish, not a build
failure."* Re-run with `make tape-audit` — the claim gets re-checked rather than
re-asserted.

### D2. Why not just feed your own x402 revenue in and call it real data?

Because it would be laundering. The x402 query fee is one flat price paid to one
wallet, so there is no price dispersion to estimate — the ledger is kept as an
authoritative, service-labelled **audit** tape, and the code says what it is
not: *"it never fabricates price signal to force a number out."*

The repo argues the cleaning stack would reject that degenerate single-seller
shape anyway, and it probably would — but **nobody has run the estimator over
the 11 receipts**, and the first-order reason is duller than the elegant one:
with 11 rows across 3 addresses you are below the hedonic stage's 8-row minimum
and inside one small community. "Too few observations" comes before "the
estimator refuses degenerate shapes". `tape_audit.py` audits `ArcSource`, not
this path — running it here is a gap worth closing.

### D3. Both sides of the futures book are you.

Conceded, in three places in the repo's own words — *"the book is first-party: our
bot makes both sides"*, *"what remains aspirational is **third-party** market
makers."*

Two things are true alongside it. The **counterparties** are no longer all
first-party: any reader can open a Circle user-controlled wallet on the Public
Desk and run the full lifecycle — faucet stake → approve → post collateral →
trade → withdraw — so external humans do take the other side of the maker, and
the UI says whose bot they are trading against. And the venue is *structurally*
open: `openSeries` takes the maker as a parameter and `trade` refuses maker
self-dealing. The liquidity is first-party; the market is not closed.

### D4. Who is actually paying you?

**Eleven Gateway settlements from exactly two payers — and both wallets are
ours.** Re-measured today at `/marketplace/receipts`: `0x784e6d2d…` ×7 (the CI
buyer agent) and `0x71e140d9…` ×4 (the autonomous hedger's backing EOA).

Lifetime revenue is therefore **0.0011 USDC — about a tenth of a cent.** Say it
before someone multiplies it out.

The honest sentence is: **the plumbing is proven, the demand is not.** Real USDC
moved through Circle Gateway, settled `exact` on `eip155:5042002`, deduped by
batch UUID, durable in-repo. But two wallets we control are not two customers,
and the only real proof of discovery would be a **third payer** we did not fund.

Two details worth keeping because they show the failure modes are understood:
the archive lives under `services/` rather than `data/` because that directory
is in both `.gitignore` and `.dockerignore` — *"an earlier version of this claim
was false for exactly that reason"* — and production has no persistent disk, so
`/revenue` read zero over a gate that had genuinely been paid until the archive
shipped inside the image.

### D5. Why is this on testnet?

Partly because Arc mainnet does not exist yet. On discoverability there is a
**direct contradiction, and it belongs here rather than in our favour**: at
their Agent Stack session Circle said *"you can absolutely list as a seller on
the testnet Agent Marketplace right now by connecting your wallet to Arc
Testnet and registering your agent."* Measured against their public Discovery
API the same week, it serves 958 listings, every one on a mainnet chain, and
`network=eip155:5042002` returns **zero**.

Both can be true — their answer may describe an internal or unreleased surface,
or may have conflated agent-wallet creation with seller listing. What is certain
is that no Arc listing is visible from outside. ACR appears to meet the
prerequisites — 402 when unpaid, serves on payment, publishes an OpenAPI spec,
payout to a Circle developer-controlled wallet — though "appears" is the honest
word: the listing surface is a Google Form and no prerequisite list is
published. That is Q3 in Part I, and it is a
question only someone who ran the query can ask.

Consequences are stated rather than glossed: agent-wallet spending policies are
mainnet-only, so **every cap in ACR is application-level** and enforced by our
own code, which is a weaker claim than a platform-enforced budget and is
documented as such.

---

## §E — The Circle stack

### E1. Which wallet type does what, and why could it not be otherwise?

This is the strongest argument in the repo, because each choice is *forced* by a
constraint rather than picked:

| Role | Wallet | Forced by |
|---|---|---|
| Press (signs oracle prints) | Developer-controlled | `ecrecover` needs an EOA account type |
| Treasury, faucet, x402 `payTo` | Developer-controlled | custody of funds; `payTo` merely *receives*, so this one is a choice rather than a constraint |
| Venue owner + maker | Developer-controlled | unattended cron; an agent wallet's OTP session expires |
| Heartbeat taker | Developer-controlled | unattended cron (an agent session expires); `require(msg.sender != s.maker)` separately forces it to be a *different* wallet from the maker |
| Desk readers | User-controlled SCA + PIN | their key must never reach our server |
| Autonomous hedger | Circle **agent** wallet | Circle's product for exactly this |

`docs/WALLETS.md` carries the full C1–C5 argument.

**Where the framing is weaker than it looks.** Not every row is *forced*: the
taker role is proven servable by a different type, because the autonomous hedger
is a Circle **agent** wallet taking the other side of the same books. And one
role in the repo's own table is served by a non-Circle wallet at all — the
offline deploy EOA, which per §H still owns `ACROracle`. The strong claim is
that the press, the desk readers and the maker/taker split are forced; the rest
is judgement.

A real separation-of-duties weakness worth volunteering: the press, treasury,
faucet and x402 `payTo` are **all the same address** (`0x8366968f…`).

### E2. What is the "two identities, one agent" thing?

An x402 `exact` settlement is EIP-3009 and the facilitator `ecrecover`s it, so a
Circle agent wallet **pays from its backing EOA** (`0x71e140d9…`) while its
**smart account** (`0x1Dc707E3…`) is what `ACRFutures.trade` records as the
taker. The transaction `from` is a third address entirely — the ERC-4337
bundler.

Three addresses, one agent. It is why `FeedAccessAttestor` has separate `payer`
and `beneficiary` fields, and it is the kind of detail that only shows up when
you actually run the thing.

**The attack:** nothing on-chain *proves* the EOA and the smart account are the
same agent. The link is asserted by the seller's attestation — which is the same
weak joint §H names — so a reader has to trust our signature that the wallet
which paid is the wallet that should get access.

### E3. How are all five Circle pillars used?

Nanopayments (the x402 gate settling through Gateway on Arc), Agent Wallets
(**all three models, live** — developer-controlled signing oracle prints,
user-controlled trading the Desk, an agent wallet running the hedger), Agent
Marketplace (a Bazaar-shaped catalog with an on-chain attestation anchor no
other listing carries), the Circle CLI (proven end-to-end — Circle's own CLI
buyer settled against the deployed gate), and Circle Skills.

**The gap, stated:** CCTP / cross-chain is the one **Agent Stack** rail ACR does
not use — that is Q4 in Part I rather than a claim. Other Circle products are
unused too (App Kit, Bridge Kit, Mint, Compliance Engine), and the ERC-4337
Paymaster is *deliberately* deferred for a good reason: USDC is Arc's native gas
token, so the press and the oracle posts are gasless without one.

---

## §F — The venue and the agents

### F1. Why build a futures venue at all?

Because it is the difference between an index and a benchmark. A benchmark is a
number something *settles against*. `ACRFutures` reads the oracle in five
places, and **settlement refuses a print older than two hours** — so the feed
has a dependent that breaks when the feed breaks. Precisely: `settle` enforces
`MAX_SETTLE_AGE`; `openSeries`, `trade` and the margin maths call `latestValue`,
which has no age check, so a stale print still fills trades. Settlement is
guarded, trading is not. That is a much stronger statement than a dashboard.

Three live books today — ACR-INF, ACR-GPU, ACR-DATA — cash-settling against the
oracle print, with a keeper that derives which indices have a live series *from
the chain* rather than from a config list, and rotates an hourly fill across
them.

**The attack, and it is circular:** the dependent is us. We publish the feed and
we deployed the contract that settles on it, so "the benchmark has a consumer"
is currently a statement about our own two components agreeing. It becomes a
real claim the first time something we did not write settles on the print.

### F2. What makes the hedger more than a demo script?

It is the only loop in the repo that makes an economic decision. Every other
agent does one leg: the buyer pays but never acts on what it bought; the
heartbeat trades but never pays for the data it trades on. The hedger does both
— *"the print it purchases is the input to the position it takes, and the log
says so."*

It also now diagnoses its own constraint. When it cannot reach its mandate it
distinguishes *the book is full* (posting margin would change nothing) from *my
own margin is full* (fixable), and in the second case posts a bounded top-up and
then trades. A run from 2026-08-04 reads: paid 0.0001 USDC for the print,
diagnosed margin-bound, posted 0.20 collateral, bought 0.18, reaching its 2.0
mandate exactly.

### F3. What keeps it alive without a human?

The venue owns itself: ownership sits with the maker's own Circle wallet, so the
keeper can open and collateralize a successor series unattended. **No scheduled
job signs with a raw private key** — the GitHub workflows are dispatch-only
fallbacks, and the keeper *refuses in code* rather than merely not being
triggered: it returns a signer only if it is a `CircleWalletSigner`, because
"returning a local-key signer here would quietly reintroduce the thing this
exists to prevent".

`make verify-live` asserts the whole thing per book: a live unexpired series,
maker *and* taker collateralized, the book able to absorb a trade both ways, and
— the check that matters for a demo — **how many full reader-sized trades each
book can still absorb before it freezes** (4.4 / 4.1 / 5.4 today).

---

## §G — Engineering worth stealing

**The connection ladder.** Six *derived* tiers — live, stale, waking,
onchain-only, archived, linking — never stored, because a stored tier can be
wrong. `linking` exists so a first paint never renders a false "archived", and
`onchain-only` is a real fallback rather than a message: the terminal reads
`ACROracle` directly with viem, so even the degraded state is on-chain truth.
Thresholds are measured (a free-tier cold start was 43–73 s), not guessed.

**`Read<T>` — "a failed read is not a state", as a type.** Two production
measurements forced it: `/api/desk/fills` returned an empty array on 1 of 5
probes for a wallet with four fills, and a throttled position read was served
**200 with a 10-second CDN cache** and rendered as "flat" — telling a reader
holding a position that they held nothing, and telling everyone else the same
for ten seconds. Most codebases keep this as a review convention; here it is a
type with four policy functions (never cache a failure, 503 not 200, keep the
last good value, never memoize a failure).

**The plain/expert edition.** The same page in two registers, selected by a data
attribute written pre-paint — CSS picks the copy, so the server HTML is
identical in both editions and hydration never diverges. Glossary entries are
capped at one line and 140 characters with no jargon inside a gloss, and CI
fails if a new surface ships without a plain variant.

**`verify_claims.py` — documentation gated against measurement.** It re-runs the
suites and fails if a doc's number disagrees. It has caught a stale count in
three consecutive sessions, including twice while writing the work this document
describes.

**The weakest point of this whole section:** none of it is the product. It is
terminal and tooling engineering in a document about a benchmark, and a reviewer
who only reads §G has learned nothing about whether the rate is any good.

**`FeedAccessAttestor`.** Circle said on-chain verification of a Gateway
settlement would need "an EIP-712 signed attestation or oracle receipt"; that
contract is the receipt, deployed the same day. Its design decision is the
interesting part: **the seller signs, it does not decide** — every attestation is
derived from rows already public at `/marketplace/receipts`, so it cannot mint
access nobody paid for.

---

## §H — The hardest questions, asked plainly

**Is this just an oracle with extra steps?**
An oracle publishes a number. This publishes an estimator with a stated
estimand, an uncertainty band the contract *checks* the print against, and a
cost-to-manipulate the contract *refuses to store as zero* — plus a venue that
settles on it. The oracle is the last stage, not the product.

**What stops you printing whatever you like?**
Today: nothing but the invariants — prints are EIP-712 signed by an authorized
signer, must carry a non-zero attack cost, and must have monotone timestamps.
That is tamper-*evidence*, not decentralization.

And the honest version is worse than "one signer", so here it is, checkable in
sixty seconds with `cast call`: **`ACROracle` has two authorized signers.** One
is the Circle custody press wallet that signs every print. The other is the
original deploy EOA — a raw offline key — which is *also still the contract's
owner*, so it can add signers, pause the feed, or transfer ownership. Revoking
it is a one-line `setSigner(deployer, false)` we have not run.

Worth separating from a claim made elsewhere in this repo: the deploy EOA holds
no authority over **ACRFutures** — that ownership migrated to the maker's Circle
wallet on 2026-08-03, which is what lets the keeper roll unattended. The oracle
was not migrated with it.

The `value` inside its own CI check is real but cannot fire for a print this
code produces: `robust.py` clamps the point inside the interval before it
leaves Python. It constrains a *different* signer, not this one.

**What breaks first at scale?**
The read path. Arc's `eth_getLogs` caps at ~15,000 blocks (413), rejects a string
`toBlock`, and throttles hard — and narrowing the range on a 429 destroys read
reach, which is measured, not theorised. That is Q5 in Part I.

**What is the single weakest joint?**
The seller signs an attestation about its own revenue. `FeedAccessAttestor` is
only as trustworthy as the seller's ledger, and the buyer has to trust the
seller's signature about the seller's own receipts. The repo names this itself
and the fix is a first-party settlement attestation from Circle.

**What would another month buy?**
A third payer we did not fund; a second independent oracle signer; empirical CI
coverage against the simulator's known latent; the bound's cap denominator keyed
off surviving rather than raw volume; and a real seller attesting quality it did
not choose itself.

**If you had to argue against your own project, what would you say?**
That an index computed from a simulator, settled on a venue whose maker is you,
paid for by two wallets you own, on a testnet, is a very good *demonstration* of
a benchmark and not yet a benchmark. Every part of that sentence is true. The
reply is that each of those is a liquidity problem rather than a design problem,
and the design — the estimand, the deconvolution, the bound, the invariants — is
the part that cannot be retrofitted later.
