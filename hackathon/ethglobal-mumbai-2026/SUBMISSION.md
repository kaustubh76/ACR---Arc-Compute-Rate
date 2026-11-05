# ETHGlobal Mumbai — submission copy

Bounty: **Arc — Arc Studio Continuity Track: Bring Your Project to Arc.**

Stated explicitly because Arc asks for it: *"Please be clear what bounty you are
submitting for as part of your submission."* Arc is one partner-prize slot.

---

## The one-liner

> This agent's wallet holds $0 — yet it never misses a bill, never overpays, and
> its budget earns yield until the second it's spent.

## What it is

ACR has printed the price of compute on Arc since September. **Float** is the
step where that price stops being a number to look at and becomes the thing that
**authorises money**.

An AI agent with a wallet has a worst case equal to its balance. Give it a
spending limit and the worst case is the limit. Neither asks the question an
overcharge actually fails: *is this a fair price?*

Float holds the budget in a vault instead. The agent's own wallet holds nothing,
permanently — there is a test that asserts it before and after every payment the
agent causes. Each request names the `printId` of the compute price it was quoted
against; the vault recomputes the fair total itself, refuses anything above a
band, pulls the **exact shortfall** out of a real yield venue and pays the seller,
**in one transaction**.

Three things follow that a spending limit does not give you:

1. **It prices the purchase.** Rig a seller to quote 3× and the chain refuses, in
   English, in a log anyone can read, with the fair counter-price attached.
2. **It funds just in time.** Idle float sits in a real ERC-4626 vault (Morpho
   Vault V2 on Arc). The money was earning yield until the block it was spent in.
3. **It parks what it cannot authorise.** Over the per-request threshold a request
   is not refused — a checkpoint opens on chain and waits for a verified human's
   single-use EIP-712 signature. An approval *widens* the band; it never removes
   it. A person can authorise paying more than usual. Nobody can authorise paying
   an unpriced amount to an unapproved seller.

## Why it is a Continuity project

ACR existed before this event: the estimator, the index, `ACROracle`,
`PolicyWallet`, the decision engine, the terminal, the subgraph. Float is new, and
the line is drawn with every number re-derivable from a named command in
[`CONTINUITY.md`](./CONTINUITY.md):

**8,383 insertions against 8 deletions, and 98.4% of the added lines are in files
that did not exist at the baseline.** For comparison, our ETHOnline continuity
disclosure reported 86.1% and 1.4% churn — the measurement is a habit here, not a
number assembled for this submission.

## How Arc Studio was used

Stated narrowly, because a narrow claim survives questioning and a broad one does
not. Full detail and the raw artifacts in [`float/studio/`](../../float/studio/).

- **It compiles the treasury policy.** The treasurer writes a sentence —
  *"Freeze the agent called waster. For everyone else, never pay more than 1%
  above the ACR fair price, keep two days of forecast spend liquid, and keep all
  of the idle float in the working vault"* — and Arc Studio emits the JSON. It
  changed exactly one field and correctly left three others alone. Its output is
  then **checked, not trusted**: our own validator refuses an invalid config
  before a transaction is built, and the chain keeps the last good policy. Studio
  said, unprompted, *"I didn't run it through a schema validator, but I checked it
  by eye"* — which is precisely the assurance the validator replaces.
- **It audits the vault**, including the human-checkpoint path, with findings
  triaged in commits that name the audit.
- **It hosts the dashboard**, byte-for-byte — verifiable with `arc-studio cat`.

What it did not do is listed too: it did not write the vault, the tests, the
keeper, the agents or the dashboard.

## What is demonstrably true

Every claim below is re-derivable by a command in the repo.

| claim | how to check |
|---|---|
| 295 contract tests, 23 unit tests | `forge test`, `npm test` |
| The agent's wallet holds nothing, before and after | `test_the_agents_own_wallet_holds_nothing_before_and_after` |
| A 3× quote is refused on chain with the fair counter-price | `npm run verify` T3 |
| The exact shortfall leaves the sleeve **before** the seller is paid, in one transaction | `npm run verify` T5 — proven by **log order**, because Arc's RPC has no `debug_traceTransaction` |
| The fair band is denominated correctly | `test_the_fair_band_is_denominated_in_usdc_not_wad` |
| Eleven acceptance checks on a live chain | `FLOAT_NET=arc-testnet npm run verify` |

## The number that makes the case

Nine providers serve the same open-weights model, `meta-llama/llama-3.3-70b`,
between **$0.000155 and $0.000783** per thousand tokens — a five-fold
disagreement about one product, measured 2026-11-05. That is why a fair price has
to be a *band*, and why the treasury carries that spread as its margin.

## Honest limits

- Prices are **published list prices** per provider, not executed fills. What the
  band constrains is what the vault will *pay*. Executed-price feeds are roadmap.
- The confidence interval is a **provider spread**, not a forecast error bound.
- Float adds **no yield of its own**; it shows accrued value, never a projected APY.
- The forecaster is deliberately simple and says *"no measured rate"* rather than
  inventing one.
- `FloatTestSeller` is ours and **says so in its own name**.

## AI use

Documented file-by-file in [`CONTINUITY.md` §6](./CONTINUITY.md), as ETHGlobal
requires. The short version: the implementation was written with Claude Code —
33 of 35 commits carry a machine-checkable `Co-Authored-By` trailer — Arc Studio
compiled the policy, and the product design, every architectural decision and the
corrections were the human's. The tension between Arc requiring an AI builder and
ETHGlobal cautioning against entirely-AI work is named there rather than avoided.

---

## Links to fill in at submission time

- **Arc Studio project URL**: https://studio.arc.io/app/b5aa43e1-4d5c-4d47-b079-dcc9aea0e557
  *(note: this requires a Circle login — see below)*
- **Public dashboard URL**: _pending_
- **GitHub**: https://github.com/kaustubh76/ACR---Arc-Compute-Rate
- **Architecture diagram**: `docs/assets/acr_float.preview.svg`
- **Video (2–4 min, 720p+, human narration)**: _pending_
- **Deployed contracts on Arc Testnet**: _pending_

### A known gap, disclosed rather than hidden

Arc's qualification block asks for *"a shareable Arc Studio project URL that
judges can open."* Our Studio project URL 302-redirects to `login.circle.com`
for anyone without a Circle account, and Arc Studio reports no public share
action; its preview host returns 403 unauthenticated. We are publishing the
dashboard to a public static host as well, so the app itself is openable by
anyone, and giving both links. If judges can open Studio project URLs directly,
the first link is the canonical one.
