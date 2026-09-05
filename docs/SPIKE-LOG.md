# Spike log — The Graph on Arc

Measurements, not assertions. Each entry records what was observed, when, and by
what command, so a reader can re-run it rather than take it on faith. Numbers
that were true when taken and later stopped being true stay here with their
date — a superseded measurement is evidence, a deleted one is a gap.

## Verified before building (2026-09-01)

The Graph's registry lists `arc-testnet` (`eip155:5042002`) and `arc` mainnet
(`eip155:5042`) as Subgraph Studio targets. A third-party Studio subgraph on
arc-testnet reported `_meta.block 59,962,511` with `hasIndexingErrors: false`
against an RPC head of 59,962,514 — **3 blocks, roughly 6 seconds of lag.**

That is the number the whole integration was staked on: if Studio could not
follow Arc closely, arrival-price selection would be measuring a stale tape.

## Chain and cost (2026-09-05)

Measured against the live RPC and from `forge test --gas-report`, not estimated.

| | |
|---|---|
| chain / head | `5042002` / block 60,535,631 |
| gas price | 25 gwei |
| `ACROracle.postPrint` (v1) | 346,182 gas → 0.00865 USDC per index |
| `ACROracleV2.postPrint` | 423,883 gas → 0.01060 USDC per index |
| `ReceiptMirror.openSettlement` | 169,208 gas → 0.00423 USDC |
| `ReceiptMirror.finalizeSettlement` | 61,645 gas → 0.00154 USDC |
| deploy `ReceiptMirror` | 1,106,811 gas → 0.0277 USDC |
| deploy `ACROracleV2` | 1,174,662 gas → 0.0294 USDC |

One press cycle across three indices costs **0.02595 USDC**; dual-posting both
oracles roughly **1.4 USDC/day**.

### The press had stopped, and this is why

On 2026-09-05 all three v1 prints were **93 hours** old — 46× past the
120-minute settle window — while the API was up and the keeper was ticking. The
poster wallet `0x8366968f…` held **0.008663 USDC** against a 0.00865 per-index
cost. It could afford one post and no more.

Not an outage. A funding failure that presented as one, which is exactly why
`verify_live.py` grades v1 staleness as a hard failure and why this log records
balances alongside gas.

## Subgraph deployment

*Pending — fill on the first `make graph-deploy`.*

| | |
|---|---|
| deployment id | |
| `_meta.block` vs RPC head at first sync | |
| `hasIndexingErrors` | |
| backfill time from the earliest `startBlock` | |
| indexed range | |

If the backfill from block 53,066,540 (roughly 7.5M blocks) proves slow, raise
`startBlock` on the older data sources and record the new value and the reason
here rather than quietly changing it.
