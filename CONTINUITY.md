# Continuity — what existed before, what was built during, and how to check

ACR is a **Continuity Project**: it existed before ETHOnline 2026 and was
extended during it. ETHGlobal's rules ask that pre-existing work be documented
and that judging attach to the new work. This document draws that line and makes
it checkable — every number below names the command that re-derives it.

The short version: **91.6% of the lines added since the baseline are in files
that did not exist at the baseline**, and deletions are **0.7%** of insertions.
The extension is almost entirely new surface sitting beside the old one rather
than a rewrite of it.

## 1 · The frozen baseline — zero credit claimed

Tag **`v1.0-submission`** = commit **`f59b17d`**, 2026-08-10.

```bash
git log -1 --format='%H %ci %s' v1.0-submission
```

Everything in that tag is pre-existing and claims no credit:

- **The estimator** — indexer, batching deconvolution, cleaning (sybil /
  self-dealing / wash detection, Louvain clustering, cluster caps), α-trimmed
  volume-weighted median, hedonic adjustment, hourly ACR-INF / ACR-GPU /
  ACR-DATA with confidence intervals and attack-cost-per-bp.
- **Contracts** — `ACROracle.sol`, `AttestationRegistry.sol`, `ACRFutures.sol`,
  `FeedAccessAttestor.sol`, and their Foundry suites and invariants.
- **The x402-gated index API** — Circle Gateway Nanopayments, the dev gate, the
  receipt ledger, webhooks.
- **The ACR Terminal** — the Next.js desk, expert/plain editions, the
  connection ladder, `/curve`, `/attack`, `/ops`.
- **The instrument layer** — Avellaneda-Stoikov maker, keeper, roll/settle.

## 2 · The commit range

Every figure below is measured over a **frozen range**, `v1.0-submission..0aff288`, not against
`HEAD`. That is deliberate: a statistic measured against a moving head is stale the
moment the commit correcting it lands — which is exactly how the earlier numbers here
went out of date. Anchored at both ends, they stay re-derivable forever, and only go
stale when someone deliberately re-anchors them.

```bash
git log --oneline v1.0-submission..0aff288      # 45 commits
git diff --shortstat v1.0-submission..0aff288
```

45 commits, no squashing, each scoped to one change. Commits that touch baseline
files say so in the subject and the body explains why.

## 3 · Diff statistics

| measure | value | command |
|---|---|---|
| files changed | 189 | `git diff --shortstat v1.0-submission..0aff288` |
| insertions | **41,200** | same |
| deletions | **280** | same |
| files added | **126** | `git diff --name-status --diff-filter=A v1.0-submission..0aff288 \| wc -l` |
| files modified | 63 | `--diff-filter=M` |
| lines in new files | **37,737** | `git diff --numstat --diff-filter=A v1.0-submission..0aff288 \| awk '{s+=$1} END {print s}'` |
| **new-file share** | **91.6%** | 37,737 / 41,200 |
| **baseline churn** | **0.7%** | 280 / 41,200 |

Read the last two rows together. A project that rewrote its baseline to look new
would show large deletions; 280 across 189 files is the signature of work added
alongside, not on top of.

## 4 · What was built during the event

New files, grouped (`git diff --name-status --diff-filter=A v1.0-submission..0aff288`):

| area | files | what |
|---|---|---|
| `graph/src`, `graph/abis`, `graph/tests` | 24 | the `acr-tape` subgraph — mappings, hand-built ABIs, matchstick suites |
| `services/index_api` | 11 | TCA, seller ratings, the subgraph proxy, the human gate |
| `packages/acr_oracle_client` | 8 | ACROracleV2, ReceiptMirror, HumanIdMirror and AgentBook readers |
| `contracts/src`, `test`, `script` | 10 | `ACROracleV2`, `ReceiptMirror`, `HumanIdMirror` + suites + deploys |
| `apps/terminal` | 6 | the tape surface |
| `mcp/src` | 3 | the MCP server — six tools over the live tape |
| `packages/acr_tape` | 3 | the graph-backed tape source |
| `anchors/`, `tests/eval`, `tests/rate` | 9 | real public price anchors, held-out eval sets, the auto-rater baseline |
| `tests/` | 3 | resistance, golden-output and human-window-parity suites |

The four things that did not exist before and carry the submission:

1. **Machine TCA** — arrival-price benchmarking for agent fills, computed in a
   public subgraph rather than asserted by us.
2. **Seller ratings** from the same tape, so a reroute points somewhere fair.
3. **A human-denominated manipulation bound** — `HumanIdMirror` records
   window-rotated cluster ids so the cap counts people, not wallets.
4. **Reach** — MCP tools and an analyst skill a judge can run against the live
   tape themselves.

## 5 · Baseline files that were touched, and why

63 files, 280 deletions total. The largest are additive:

| file | +/− | why |
|---|---|---|
| `apps/terminal/lib/fallback.json` | +1259 −109 | regenerated cold-start bundle (data, not logic) |
| `acr_oracle_client/client.py` | +333 −43 | ACROracleV2 support beside v1; v1's six signed fields are a strict typehash prefix so the immutable `ACRFutures.oracle` is never orphaned |
| `services/index_api/app.py` | +223 −2 | new routes mounted; existing ones untouched |
| `Makefile` | +195 −8 | new targets appended |
| `scripts/verify_claims.py` | +106 −2 | new claims added to the audit |
| `acr_core/config.py` | +73 −2 | new settings; defaults keep old behaviour |

No baseline behaviour was changed to make a new number look better. Where the
estimator itself was corrected — a rate that moved with event arrival order, a
median discontinuity, an uncalibrated interval — the correction is its own
commit, the measurement is in the message, and `docs/methodology.md` discloses
what is still wrong (interval coverage is 22% against a nominal 95%, and the
reference levels are 20–1159× above real market prices).

## 6 · The spike log

`docs/SPIKE-LOG.md` records what was measured, when, and by what command,
including measurements that later stopped being true — kept with their dates,
because a superseded measurement is evidence and a deleted one is a gap.

## 7 · Re-deriving every number here

```bash
git log -1 --format='%H %ci %s' v1.0-submission
git log --oneline v1.0-submission..0aff288 | wc -l
git diff --shortstat v1.0-submission..0aff288
git diff --numstat --diff-filter=A v1.0-submission..0aff288 | awk '{s+=$1} END {print s}'
uv run python scripts/verify_claims.py     # every documented number, re-measured
uv run pytest -p no:cacheprovider          # 555 passed, 0 skipped
cd contracts && forge test                 # 156 passed
```

`scripts/verify_claims.py` is the repo's own gate: it re-measures the test
counts, the deployed addresses and the published claims against the documents
that assert them, and CI fails when a document drifts from reality.
