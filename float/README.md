# Float — an agent treasury that forecasts, earns, and refuses

> This agent's wallet holds $0 — yet it never misses a bill, never overpays, and
> its budget earns yield until the second it's spent.

ACR has printed the price of compute since September. Float is the step where
that price stops being a number to look at and becomes the thing that
**authorises money**.

## The problem a spending limit does not solve

Give an agent a wallet and its worst case is the balance. Give it a spending
limit and its worst case is the limit. Neither asks the question that an
overcharge actually fails: **is this a fair price?**

Float holds the budget in a vault instead. The agent's own wallet holds nothing,
permanently, and there is a test that asserts it. Every payment request names
the `printId` of the compute price it was quoted against; the vault recomputes
the fair total itself, refuses anything above a band, pulls the **exact
shortfall** out of a yield venue, and pays the seller — in one transaction.

Three things that follow, none of which a limit gives you:

**It prices the purchase.** Rig a seller to quote 3× and the chain says no, in
English, in a log anyone can read, with the fair counter-price attached.

**It funds just in time.** Idle float sits in a real ERC-4626 vault. The money
was earning yield until the block it was spent in.

**It parks what it cannot authorise, rather than denying it.** Over the
per-request threshold the request is not refused — it opens a checkpoint on
chain and waits for a human's single-use signature, bound to that exact request.
An approval **widens** the band; it never removes it. A person can authorise
paying more than usual. Nobody can authorise paying an unpriced amount to an
unapproved seller.

## Run it

```bash
cd contracts && forge build && forge test     # 300 tests
anvil                                          # in another shell
cd float && npm install
npm test                                       # 23 unit tests
npm run local                                  # deploy the whole system
npm run keeper -- --once                       # put real prices on chain
npm run verify                                 # 12 checks against the live chain
npm run agents -- --once --park 0.5            # watch the hero loop
```

`npm run verify` prints what it observed, not just a verdict:

```
PASS  T5   the exact shortfall leaves the yield sleeve BEFORE the seller is paid,
           in one transaction
           jitFunded=true; sleeve pull at log 1 < payment at log 2;
           requested $0.53025 = shortfall $0.53025, delivered $0.53025;
           sleeve $98.41975 -> $97.8895
```

Arc's public RPC does not support `debug_traceTransaction` or the `trace_`
namespace — both answer `-32601` — so "the sleeve was pulled before the seller
was paid" is proven by **log index inside one receipt** rather than by walking
internal calls. That is a better proof anyway: anyone with an ordinary RPC can
check it.

## What it is made of

| contract | what |
|---|---|
| `contracts/src/float/FloatVault.sol` | the treasury: policy, per-agent caps and freeze, seller allowlist, the fair band, just-in-time funding, receipts, checkpoints, single-use EIP-712 approvals |
| `contracts/src/float/FloatPrintStore.sol` | per-model USD prices with an incrementing `printId` |
| `contracts/src/float/Sleeves.sol` | `Erc4626Sleeve` against a real yield venue; `NullSleeve` |
| `float/src/prices.ts` | per-provider medians and a measured confidence interval |
| `float/src/bin/keeper.ts` | print → forecast → rebalance, every ten minutes |
| `float/src/bin/policy.ts` | English → JSON → chain, validated all-or-nothing |
| `float/src/bin/verify.ts` | the twelve checks above |

## The price is measured, not asserted

The method is ACR's own, from `anchors/_basket/ACR-INF.json`: a 0.75/0.25
prompt:completion blend for a read-heavy agent workload, `usd_per_token * 1000`,
median. Float follows it exactly, so the per-model prints and the index are one
measurement at two scales.

The check that they agree: the blend of `openai/gpt-4o-mini`'s published prices
is **$0.0002625/1k**, and ACR's own `GET /par` independently reports
**0.0002625** for that model.

What is new is the **spread**. ACR's basket takes one list price per model;
Float asks for a model's per-provider endpoints, which is where a measured
confidence interval comes from. Measured 2026-11-05:

| model | providers | spread | price |
|---|---|---|---|
| `openai/gpt-4o-mini` | 3 | 500 bp | $0.0002625/1k |
| `deepseek/deepseek-chat` | 3 | 1027 bp | $0.000450225/1k |
| `meta-llama/llama-3.3-70b-instruct` | 9 | 3437 bp | $0.00064/1k |

The last row is the argument for the whole product: **nine providers serve the
same open-weights model between $0.000155 and $0.000783** — a five-fold
disagreement about one thing. That is why the fair band is a band, and why the
forecaster spends the spread as its safety margin.

A model with fewer than two priced providers is **refused, not averaged**. One
provider's price is that provider's price; calling it a market median is a claim
the data does not support.

## Units, stated once

Every amount is USDC on Arc's ERC-20 view, **1e6**. Every price is USD per
bundle, **1e18**. `units` is a dimensionless count. The only conversion is:

```
fairUsdc6 = priceWad * units / 1e12
```

It appears exactly once in the contract. Writing `fair = priceWad * units` and
comparing it to a 1e6 quote — which the first draft of this design did — makes
`fair` 1e12 too large, so **the band can never fire** and a 3× overcharge is
paid. The feature would look implemented and be absent.
`test_the_fair_band_is_denominated_in_usdc_not_wad` exists to keep it that way.

## Honest about what is not here

- **Prices are published list prices**, per provider, not executed fills. A
  seller could in principle quote one thing and charge another off-chain; what
  the band constrains is what the vault will *pay*. Executed-price feeds are the
  roadmap, not a claim.
- **The confidence interval is a provider spread**, not a forecast error bound.
- **The yield is whatever the venue pays.** Float adds no yield of its own and
  shows accrued value rather than a projected APY.
- **The forecaster is deliberately simple**: measured spend per hour × hours of
  cover × (1 + spread). With no receipts it reports "no measured rate" instead of
  inventing one.
- **`FloatTestSeller` is ours and says so in its own name**, because a demo that
  pays a seller the team controls should admit it on chain.

## Continuity

Float is new work built during ETHGlobal Mumbai on a codebase that existed
before it. The line is drawn, with every number re-derivable from a named
command, in
[`hackathon/ethglobal-mumbai-2026/CONTINUITY.md`](../hackathon/ethglobal-mumbai-2026/CONTINUITY.md):
**8,383 insertions against 8 deletions, 98.4% of added lines in files that did
not exist at the baseline.**

## Arc, specifically

Four things that cost time if you meet them blind, all verified:

1. A transaction with `maxFeePerGas` below **20 Gwei** is **silently dropped** by
   Arc's mempool. No receipt, no error.
2. USDC is the gas token and has **two decimal views** of one balance: 18 native,
   6 on the ERC-20 view at `0x3600…0000`.
3. The Morpho Vault V2 that Earn Kit discovers returns **zero from every `max*`
   function** by design, and its shares are **18dp against a 6dp asset**. Sizing
   a withdrawal from `maxWithdraw` reports an empty sleeve forever.
4. `eth_getLogs` is capped at a **10,000-block range**, so reach comes from
   paging.
