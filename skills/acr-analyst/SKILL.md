---
name: acr-analyst
description: Interrogate the ACR machine-TCA tape on The Graph in plain English — what an AI agent paid for compute, how that compares to the benchmark it could have seen, which sellers are dear, and whether a published print reproduces from public data. Use with The Graph's Subgraph MCP against the acr-tape subgraph, or with ACR's own read proxy. Triggers on: machine TCA, transaction cost analysis for agents, ACR tape, slippage vs arrival, seller rating, acr-tape subgraph, which seller overcharged.
---

# Ask the ACR tape

`acr-tape` indexes every ACR print on Arc and every mirrored x402 settlement
benchmarked against them. Slippage is computed **inside the subgraph mappings**,
not by a service you have to trust — so every number below is one you can
re-derive from the same public data.

Two ways in. Either works; the first needs no key.

```bash
# ACR's read proxy — an allowlist of named operations, Studio key server-side
curl -s https://acr-api-1fto.onrender.com/graph/operations
curl -s -X POST https://acr-api-1fto.onrender.com/graph/query \
  -H 'content-type: application/json' -d '{"operation":"meta"}'
```

Or point The Graph's **Subgraph MCP** at the `acr-tape` deployment and query it
directly. This skill is the schema map you need either way.

## What the tape holds

| Entity | One row is | The fields that matter |
|---|---|---|
| `Print` | one `PricePosted`, from either oracle | `index`, `value`, `ciLo`/`ciHi`, `attackCostPerBp`, `postedAt`, `oracleVersion` |
| `EconomicPrint` | the deduplicated print both oracles posted | `postedAt` (first posting only), `policyHash`, `windowStart`/`windowEnd`, `oracleMask`, `divergent` |
| `SignerChange` / `PauseChange` | who could sign, and when a feed stopped | `contractName`, `signer`, `allowed`, `paused` |
| `CollateralFlow` | money entering or leaving the venue | `trader`, `amount`, `deposited` |
| `Settlement` | one mirrored x402 purchase, benchmarked | `unitPrice`, `arrivalValue`, `slippageBp`, `benchmarked`, `synthetic` |
| `PendingSettlement` | a purchase whose quantity has not been decoded yet | `settledAt`, `mirrorLagSeconds`, `unbenchmarkedReason` |
| `SellerDay` / `PayerDay` | a day of flow, rolled up in the mapping | `volume`, `bmVolume`, `wSlipTenthBp`, `synthVolume`, `n`, `b0..b6` |
| `Seller` / `Payer` | a party | `totalVolume`, `distinctPayers`, `latestAttestation` |
| `FuturesFill` | a real on-chain futures fill | `mark`, `slippageBp` — **structurally zero, see below** |

**Units, once.** Prices and quantities are WAD `1e18`. USDC amounts are `1e6`.
`slippageBp` is basis points; `wSlipTenthBp` is *tenths* of a basis point summed
against volume, so volume-weighted slippage in bp is
`wSlipTenthBp / bmVolume / 10`.

**`benchmarked: false` is not zero slippage.** It means no ACR print preceded
that settlement, and `unbenchmarkedReason` says which case: `NO_PRINT_YET` (it
predates the feed) or `RING_UNDERFLOW` (the keeper was down too long). Filter
these out; never read them as fair pricing.

## Six questions, and the shapes to expect

**1 — Which agent overpaid most against the benchmark?**

```graphql
{ payerDays(orderBy: overpay, orderDirection: desc, first: 5) {
    payer { id } spent bmSpent overpay n } }
```
Expect USDC-1e6 integers. `overpay / 1e6` is dollars paid above arrival. A payer
with `n: 0` bought nothing benchmarkable — not "bought perfectly".

**2 — Is this seller getting dearer?**

```graphql
{ sellerDays(where: {seller: "0x…"}, orderBy: day, orderDirection: desc, first: 14) {
    day volume bmVolume wSlipTenthBp n synthVolume } }
```
Compute `wSlipTenthBp / bmVolume / 10` per day and read the trend. Cross-check
`Seller.latestAttestation.blockTime` — a seller whose attestation has gone stale
while its slippage climbed is the interesting case.

**3 — How much of this tape is ours?**

```graphql
{ sellerDays(first: 100) { seller { id } volume synthVolume realVolume } }
```
`synthVolume / volume` is the grader-controlled share. On testnet expect this to
be high, and say so: it is disclosed on chain per settlement, not inferred.

**4 — Does a published print reproduce from public data?**

```graphql
{ prints(where: {index: "ACR-INF"}, orderBy: postedAt, orderDirection: desc, first: 1) {
    value ciLo ciHi postedAt attackCostPerBp } }
```
Then `make recompute` in the repo re-runs the estimator over the same indexed
settlements and reports whether the published value sits inside the interval the
public tape supports.

**5 — What would rerouting have saved?**

```graphql
{ settlements(where: {payer: "0x…", benchmarked: true}, first: 500) {
    seller { id latestAttestation { modelClass } } amount slippageTenthBp index } }
```
Group by seller, take `sum(amount × slippageTenthBp) / sum(amount) / 10` for each,
and compare the dearest against the cheapest **of the same `modelClass`** — which
is why the query reaches through to the attestation rather than stopping at the
seller id. Across classes the gap is quality, which the hedonic stage adjusts
away; it is not evidence anyone overcharged.

**6 — Is the tape actually fresh?**

```graphql
{ _meta { block { number timestamp } hasIndexingErrors } }
```
Then check `Settlement.mirrorLagSeconds`: the gap between the off-chain
settlement and the on-chain mirror. Arrival prices are chosen from `settledAt`,
not from the mirror block, so lag costs freshness but cannot move which print a
payer was measured against.

## Two things not to conclude

**Futures fills are a control group, not a signal.** `ACRFutures.trade` fills at
`oracle.latestValue` — the fill price *is* the arrival price — so `FuturesFill`
slippage is zero **by construction**. It is real, non-synthetic on-chain flow
whose right answer is known in advance, which makes it the best available check
that arrival selection works. It is deliberately excluded from `SellerDay`, and
pooling it back in would flatter every seller grade.

**A rating is not a market verdict.** Every rating carries `n`, the synthetic
share, and `weight_covered_pct` — the share of the published methodology the
grade actually rests on. Components with no data yet (cleanliness, human depth)
are excluded from the weighting rather than scored zero. So today a grade rests
on **55%** of the published weights for an attested seller, and 40% for one that
has never attested — never 100%. Quote the coverage with the letter.

## The repo

`https://github.com/kaustubh76/ACR---Arc-Compute-Rate` — `graph/` holds the
schema and mappings, `scripts/recompute.py` the verification, and `mcp/` an MCP
server exposing the same questions as tools.
