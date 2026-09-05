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

## The loop, proven end to end (2026-09-05)

The first real settlements ever mirrored on chain. Every step is a real
transaction or a real Circle Gateway batch — nothing seeded, nothing simulated.

**What made this possible on the day.** `/compute/{label}` had been live and
tested since the fleet landed, and appeared in **no catalog listing**, so a
buyer agent — which picks what to pay for out of `/marketplace/catalog` — could
never reach one. Every settlement in the system was still going to the single
platform wallet at the single flat price. The fleet is now discoverable, and
these are the first payments to arrive because of it.

### 1 — three real x402 settlements, three distinct sellers

Buyer `0x784e6D2d…` paying a local API running this branch, gated by the real
Circle facilitator (`gateway-api-testnet.circle.com`, `exact` over EIP-3009).
The oracle, venue and mirror addresses were blanked for that process so the run
could not post prints or trade; the only money that moved is below.

| listing | seller (payee) | paid | Gateway batch |
|---|---|---|---|
| `acr-seller-inf-mid-b` | `0x500C3A34…` | 0.005101 | `851fde9e-5db7-4f0d-b9c7-d15c666359a6` |
| `acr-seller-inf-mid-a` | `0x3d5364f5…` | 0.005229 | `d3eeca32-16e7-4272-a081-31c0ecf196f8` |
| `acr-seller-data-small` | `0x0721821F…` | 0.003718 | `48e58bfb-8b4e-4b0b-93d3-e5a5a95fbe15` |

Three payees, three prices. Every one of those addresses is already attested on
`AttestationRegistry`, so the hedonic stage reads real metadata for a real payee.

### 2 — mirrored to `ReceiptMirror`, two phases each

`make mirror-receipts` — signed, self-checked against the contract's own digest
view, then broadcast. Six transactions, block 60,552,484 → 60,552,543.

| settlement | opened | finalized |
|---|---|---|
| `0x10c4d58fae…` | [`0x10fb7bff…`](https://testnet.arcscan.app/tx/0x10fb7bff15590936d5a4abf80586069360c95319c17a648c84ff354fce14e85d) | [`0x2719ee18…`](https://testnet.arcscan.app/tx/0x2719ee18509d22c8d1657291c6a66629dd7468fb0582bdd8266d43ff8f2b8f01) |
| `0xf8d6c43110…` | [`0xb5b21cec…`](https://testnet.arcscan.app/tx/0xb5b21cec62f48cb07dfa923a608fcd242927f6cc2c05d5c96b7cd48a6411d7ac) | [`0x91d022f0…`](https://testnet.arcscan.app/tx/0x91d022f0d790b70df614a5e7b452ce3e8d1237dff36435e6718de6ffc32b9103) |
| `0x37a6d886fc…` | [`0x522a2c5a…`](https://testnet.arcscan.app/tx/0x522a2c5ae54060c390de91c21c272b92b9af64894b520c898f4a9f75abc6e275) | [`0x4060b8a2…`](https://testnet.arcscan.app/tx/0x4060b8a2f4da7b4adeb68b10527ab2e2e9bf68fb778127de067da4c8d93ffe7f) |

Observed `mirrorLagSeconds` 57 and `finalizeLagSeconds` 5–6, all well inside
`MAX_MIRROR_LAG` (1 h), and `late: false` on every one. A second run mirrored
nothing and said so — the two-phase replay guards hold.

`synthetic: true` on all three, correctly: the payer is our own demo buyer and
`is_synthetic()` derives that from the keys this deployment holds. A
third-party payer records `false`. That is why `SellerDay.realVolume` is still
zero — not because nothing is marked, but because no outside money has paid the
fleet yet, which is the honest reading.

### 3 — the slippage the subgraph should compute

Hand-computed from the paid unit price against each candidate arrival print, so
the mapping's output can be checked rather than trusted. Arrival at the time of
settlement:

* v1 `ACR-INF` 0.49112047 (ts 9,547,200, postedAt 1788594857)
* v2 `ACR-INF` 0.49910067 (ts 7,333,200, postedAt 1788594210)

| listing | paid | vs v1 | vs v2 |
|---|---|---|---|
| `acr-seller-inf-mid-a` | 0.52294118 | **+647.9 bp** | +477.7 bp |
| `acr-seller-inf-mid-b` | 0.51007843 | **+386.0 bp** | +220.0 bp |
| `acr-seller-data-small` | 0.00185890 | **−836.7 bp** | −715.2 bp |

Two-sided and non-zero — which is the whole point, since a flat single-payee
tape makes every payer's slippage identically zero by construction. The
like-for-like pair is the number that matters: **mid-a cost 262 bp more than
mid-b for the same model class on the same index**, and that gap is what a
reroute suggestion is allowed to be built on.

**Which arrival the mapping will pick, and why the two differ today.** v1 and
v2 are currently at *different* economic timestamps (9,547,200 vs 7,333,200)
because the deployed press does not yet dual-post — v2 holds only the backfill.
So the ring carries two distinct `EconomicPrint`s and arrival selection resolves
to the most recently posted one before `settledAt`, i.e. v1's. Once
`ACR_ORACLE_V2_ADDRESS` is set on the live service the two generations post the
same `ts` and collapse onto one `EconomicPrint`, which is exactly what
`src/oracle.ts`'s dedupe exists for. Expect the v1 column above to be the one
the subgraph reproduces until then.

## Subgraph deployment

### Build is deployable; the Studio record is not there yet (2026-09-05)

`make graph-deploy` ran the whole path for real. Codegen, WASM compile and the
IPFS upload all succeeded — the compiled subgraph is
**`Qmb8Dw6cBZjzkCx4PRc7BC8defLxgLZJDBLoho2oocsjZf`**, six data sources, mappings
built against the checked-in ABIs. Studio then refused the final step:

```
✖ Failed to deploy to Graph node https://api.studio.thegraph.com/deploy/: Subgraph not found.
```

Three things were learned by running it, each of which had cost a deploy:

* **`--network arc-testnet` breaks the deploy.** That flag rewrites every data
  source's address from `networks.json`, which does not exist here — and if it
  did, it would overwrite the addresses the target's own placeholder guards had
  just checked. `subgraph.yaml` declares the network on all six sources and
  holds the real deploy blocks, so the flag is removed.
* **A missing `-l` opens an interactive prompt**, so the runbook's own step
  hangs under any non-tty caller. Now `-l $(VERSION)`, default `v0.1.0`.
* **"Subgraph not found" does not mean the deploy key is wrong.** A control
  deploy to a deliberately nonsense slug returns the identical message, so the
  error cannot distinguish a bad key from a slug that was never created. The
  slug must exist in Studio first; the CLI cannot create one.

The account's subgraphs cannot be enumerated with a deploy key either —
`authUserSubgraphs` answers `Please login first`, as does `subgraph(name:)`. So
the slug has to come from whoever holds the browser session.

Also measured: neither supplied key authenticates at the query gateway —
`https://gateway.thegraph.com/api/<key>/subgraphs/id/…` answers `auth error: API
key not found` for both. A Studio *development* deployment is queried at
`https://api.studio.thegraph.com/query/<account-id>/<slug>/<version>` and does
not need a gateway key; a gateway key becomes relevant only once the subgraph is
published to the network.

*Still to fill on the first successful deploy:*

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
