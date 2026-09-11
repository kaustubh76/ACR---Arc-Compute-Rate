# Graph integration — the operator runbook

Five steps, in this order. Everything is built and tested; each of these needs
live credentials, and two of them are **not recoverable if done out of order**.

Read the two warnings first — they are the only ways this sequence can cost
something real.

> **Never repoint `ACR_ORACLE_ADDRESS`.** `ACRFutures.oracle` is `immutable`,
> and `settle()` refuses a print older than `MAX_SETTLE_AGE = 7200`. Two hours
> after the last v1 print, every expired open series becomes unsettleable and
> its collateral sits stranded until v1 prints again. v2 is deployed *alongside*
> v1 and the poster writes to both. v1 is never allowed to go stale to serve v2.

> **Backfill v2 before its first live post.** `postPrint` enforces *strictly*
> monotone economic timestamps, so once v2 takes one live print no earlier one
> can ever be inserted. A v2 that starts empty stays empty for its whole
> history, the subgraph's arrival ring has nothing in it, and every settlement
> comes back `benchmarked: false`.

---

## 1 · Attest the seller fleet

The fleet is what makes transaction-cost analysis mean anything: before it,
every settlement paid one wallet one flat price, so slippage-versus-benchmark
was identically zero for everyone. Two of its sellers are new.

```bash
make attest-once     # files all six DEMO_SELLERS on the live registry
make snapshot        # regenerates apps/terminal/lib/fallback.json from chain
```

**Why it is first:** `apps/terminal/lib/chain.test.ts` asserts that every label
in `demo_sellers.py` derives to an address actually filed on Arc — it reads the
attested set out of `fallback.json`. Until this runs, the terminal CI job is red
on that one test. The `123 terminal` figure in the docs is already correct for
the post-attestation state; do not lower it.


## 2 · Deploy the ReceiptMirror

Circle Gateway settles x402 off-chain and returns a batch UUID, not a
transaction. There is no settlement event on Arc for a subgraph to index, so
without this contract the tape does not exist.

```bash
export DEPLOYER_PRIVATE_KEY=0x…
export ACR_MIRROR_SIGNER=0x…      # the wallet that signs oracle prints
make deploy-mirror-dry            # simulate first
make deploy-mirror
```

Then record it in **two** places:

- `.env` / Render → `ACR_RECEIPT_MIRROR_ADDRESS=0x…`
- `graph/subgraph.yaml` → the `ReceiptMirror` data source's `address` **and**
  its `startBlock` (the deploy's block number).


## 3 · Deploy oracle v2

```bash
export ACR_ORACLE_V2_SIGNER=0x…   # the same print signer
make deploy-oracle-v2-dry
make deploy-oracle-v2
```

Set `ACR_ORACLE_V2_ADDRESS`. **Leave `ACR_ORACLE_ADDRESS` on v1.** Add the v2
data source's `address` and `startBlock` to `graph/subgraph.yaml` and redeploy
the subgraph.


## 4 · Backfill v2 — before any live post

```bash
make backfill-oracle-v2 ARGS=--dry-run   # read the plan first
make backfill-oracle-v2
```

It re-signs v1's last 48 hours under the v2 typehash and posts them ascending,
stamped with a distinguished policy hash (`sha256("acr.oracle.v2.backfill")`) so
anyone re-deriving the tape can tell these were re-signed during the migration
rather than produced by the estimator at the time. It refuses to post anything
that would put v2 *ahead* of v1, because the poster seeds its cursor from the
maximum across both and a v2 that runs ahead would revert every subsequent post
forever.

Only after this should the poster be allowed to take a live v2 print — which it
does automatically, on the next cycle, once `ACR_ORACLE_V2_ADDRESS` is set.


## 5 · Deploy the subgraph

```bash
# The slug must ALREADY EXIST in Studio — the CLI cannot create one, and an
# unknown slug answers with a bare "Subgraph not found" that is identical to
# what a bad deploy key returns. Create it at https://thegraph.com/studio.
npx graph auth <deploy-key>
make graph-deploy SUBGRAPH=<slug>        # default slug: ethonline
```

Do **not** run `graph init` from Studio's onboarding panel: it scaffolds a fresh
boilerplate subgraph, and this one already exists in `graph/`. Only the slug and
the deploy key from that panel matter here.

Deployed 2026-09-05 as `ethonline`, deployment
`Qmb8Dw6cBZjzkCx4PRc7BC8defLxgLZJDBLoho2oocsjZf`, query endpoint:

```
https://api.studio.thegraph.com/query/1758707/ethonline/v0.1.0
```

That is the Studio *development* endpoint and needs no gateway API key. A
`ACR_GRAPH_API_KEY` only matters once the subgraph is published to the network.

`make graph-deploy` refuses while **any** data source still holds a placeholder
address *or* `startBlock: 0`. That is why it comes last: a subgraph pointed at
`0x0` indexes nothing, reports no error, and serves an empty tape that reads
exactly like a quiet market — and a `startBlock` of 0 makes the indexer scan the
whole chain instead of starting at the deploy.

Then set `ACR_SUBGRAPH_URL` (and `ACR_GRAPH_API_KEY`, server-side only), and
record in `docs/SPIKE-LOG.md`: `_meta.block` against RPC head, whether
`hasIndexingErrors` is false, and how long the backfill from block 53066540
actually took. If it is slow, raise `startBlock` and say so there.


---

## Checking it worked

```bash
make verify-live                  # v1 freshness is a hard fail; v2 is a warn
make recompute                    # recomputed value within the on-chain CI
make recompute ARGS=--rederive-cleaning
curl -s $ACR_API/tca/<payer>      # carries n and the synthetic share
curl -s $ACR_API/rating/<seller>  # plus weight_covered_pct
curl -s -X POST $ACR_API/graph/query -H 'content-type: application/json' \
  -d '{"operation":"meta"}'       # _meta.block vs head, hasIndexingErrors
curl -s $ACR_API/graph/operations  # every operation the proxy will run
```

**Arguments go in `variables`, not at the top level.** Four operations need one
(`prints`/`economicPrints` take `index`, `sellerDays` takes `seller`,
`payerDays` takes `payer`); the rest only take the optional `first`:

```bash
curl -s -X POST $ACR_API/graph/query -H 'content-type: application/json' \
  -d '{"operation":"prints","variables":{"index":"ACR-INF","first":5}}'
```

Omit a required one and the proxy names it (`needs variable(s) index`) rather
than reporting the subgraph as unreachable — the two are very different
problems and used to produce the same message.

The mirror keeper runs on its own timer inside the service (`ACR_KEEPER_MIRROR_S`,
120s default) and reports on `/health` under `keeper.mirror`. For a first run or
a backlog, `make mirror-receipts` is the same code path by hand.

## Recurring chore — re-resolve humans every rotation window

**A human resolution goes stale on a seven-day clock, and it fails SILENTLY.**

`HumanIdMirror` mints a cluster id per rotation window (`RATING_WINDOW = 7 days`), so a wallet
resolved in window *N* has no cluster in window *N+1*. Nothing errors when the window rolls: the
subgraph simply finds no clusters for the current window, `/api/humanid` reports `"n": 0`, the
dateline's humans chip disappears, and every surface goes quiet as though nobody had ever been
verified. There is no message anywhere saying "these resolutions belong to last week".

Measured 2026-09-12: the roll from 2957 to 2958 did exactly this to production, and it was only
noticed because a deploy check happened to read `humans.n`.

```bash
# Which window are we in, and when does it roll?
uv run python -c "import time;W=604800;c=int(time.time()//W);print(c, time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime((c+1)*W)))"

# Re-resolve. ALWAYS dry-run first; it signs and checks against the contract's own digest.
ACR_HUMANID_MIRROR_ADDRESS=0x… uv run python scripts/resolve_humans.py --dry-run
ACR_HUMANID_MIRROR_ADDRESS=0x… uv run python scripts/resolve_humans.py --commit
```

**Run it BEFORE the tape moves on.** `Settlement.human` is stamped at finalize and the entity is
immutable, so a payer that settles while unresolved is counted non-human forever; the subgraph
flags it (`Payer.resolvedLate`) but cannot repair it.

Confirm with `clusterOf(wallet, <window>)` on chain, not with the absence of an error — the whole
failure mode here is that absence looks like success.

## What stays unfinished, deliberately

- **`humanAdjustedBound` is absent, not zero.** The contract accepts `0` as the
  "not computed" sentinel and the tape stores it as null. It stays that way
  until the World module lands: publishing the human bound equal to the wallet
  bound would claim identities are as cheap to buy as wallets, which is false.
- **Cleanliness and human-depth are excluded from seller ratings**, not scored
  zero — every rating carries `weight_covered_pct` so a reader knows what share
  of the published methodology the grade actually rests on.
- **The Terminal still reads v1.** Appending fields keeps the first seven words
  of the struct byte-identical, so it decodes v2 correctly and simply cannot see
  the new fields. Updating it is mainnet-week work.
