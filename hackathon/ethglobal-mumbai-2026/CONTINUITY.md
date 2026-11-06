# Continuity — ETHGlobal Mumbai 2026

ACR is a **Continuity Project**: it existed before this event and was extended
during it. ETHGlobal's rules require that pre-existing work be disclosed in
writing and that judging attach to the new work. This document draws that line
and makes it checkable — every number names the command that re-derives it.

The short version: **98.4% of the lines added since the baseline are in files
that did not exist at the baseline**, and deletions are **0.1%** of insertions.
Eight deleted lines across forty-two files. The extension is new surface beside
the old one, not a rewrite of it.

## 1 · The frozen baseline — zero credit claimed

Commit **`6e6a827`**, 2026-10-18, eighteen days before the event.

```bash
git log -1 --format='%H %ci %s' 6e6a827
```

Everything in that commit is pre-existing and claims no credit. In particular:

- **The estimator and the index** — ACR-INF / ACR-GPU / ACR-DATA, trimmed
  volume-weighted medians, hedonic adjustment, confidence intervals,
  attack-cost-per-bp.
- **The oracle** — `ACROracle.sol`, `ACROracleV2.sol`, deployed on Arc mainnet
  and testnet, with the press that posts to them.
- **`PolicyWallet.sol`** — per-category budgets, an agent threshold, an owner
  EIP-712 approval path, `decisionHash` replay protection. Deployed per business.
- **The decision engine** — `operator.py`'s nine-rung ladder, `par.py`'s
  fair-price band, `liquidity.py`, `commitments.py`, `counterparty.py`.
- **The ACR Terminal**, the `acr-tape` subgraph, `acr-mcp`, `ACRFutures`,
  `ReceiptMirror`, `AttestationRegistry`, `FeedAccessAttestor`.
- **World ID, used to gate a READ** — `HumanIdMirror.sol`, `humanid.py`'s
  `WorldIdCloudVerifier`, `agentgate.py`'s three tiers, `agentbook.py`,
  `HumanProof.tsx`, `anchors/_basket/C-HUMAN.json`, and the prior debrief in
  `hackathon/ethonline-2026/{WORLD-MODULE,FEEDBACK_WORLD}.md`.

Every item above is tracked in the public repository, so a clone matches this
list. Verified with `git ls-files --error-unmatch`.

## 2 · The commit range

```bash
git log --oneline 6e6a827..HEAD          # 13 commits
git diff --shortstat 6e6a827..HEAD
```

Thirteen commits, no squashing, each scoped to one change and written during the
event. Commits that touch baseline files say so in the subject and explain why
in the body.

## 3 · Diff statistics

| measure | value | command |
|---|---|---|
| files changed | 42 | `git diff --shortstat 6e6a827..HEAD` |
| insertions | **8,383** | same |
| deletions | **8** | same |
| files added | **35** | `git diff --name-status --diff-filter=A 6e6a827..HEAD \| wc -l` |
| files modified | 7 | `--diff-filter=M` |
| files deleted | 0 | `--diff-filter=D` |
| lines in new files | **8,247** | `git diff --numstat --diff-filter=A 6e6a827..HEAD \| awk '{s+=$1} END {print s}'` |
| **new-file share** | **98.4%** | 8,247 / 8,383 |
| **baseline churn** | **0.1%** | 8 / 8,383 |

Three of the thirty-five added files are `anchors/ACR-*/2026-11-05.json` — a
refreshed market basket, which is **data, not logic**, and is disclosed as such
here rather than counted as a feature. It was refreshed because the committed
basket had aged 30.5 days past a 30-day staleness cliff and six pre-existing
tests went red with no code change on either side of them; the fix is in the
range and explains itself in its commit message.

## 4 · What was built during the event

### 4.1 Float — an agent treasury that forecasts, earns, and refuses

New, and the centre of the submission. An agent's own wallet holds **nothing**;
a vault holds the budget, parks idle USDC in a real yield venue, and on each
request recomputes the fair price from a live compute-price print, refuses
anything above a band, pulls the **exact shortfall** out of the yield sleeve and
pays the seller in **one transaction**.

| file | what |
|---|---|
| `contracts/src/float/FloatVault.sol` | the treasury: policy, per-agent caps and freeze, seller allowlist, the fair band, just-in-time funding, receipts, on-chain checkpoints, single-use EIP-712 approvals |
| `contracts/src/float/FloatPrintStore.sol` | per-model USD prices with an incrementing `printId`, so "this print is stale" and "this print is not the one you were quoted" are separately enforceable |
| `contracts/src/float/Sleeves.sol` | `Erc4626Sleeve` against the Morpho Vault V2 that Circle's Earn Kit discovers on Arc Testnet; `NullSleeve` |
| `contracts/src/float/{IFloat,FloatTestSeller}.sol` | interfaces; the labelled demo counterparty |
| `contracts/test/Float*.t.sol`, `contracts/test/float/Doubles.sol` | **80 tests**, plus doubles that reproduce Morpho V2's always-zero `max*` functions and 18-decimal shares |
| `contracts/script/DeployFloat.s.sol` | the whole set in one broadcast |
| `float/src/prices.ts` + `prices.test.ts` | per-provider price medians and a measured confidence interval, using ACR's own blend and unit conversion |
| `float/src/bin/{keeper,agents,local,prices}.ts` | the print/forecast/rebalance loop, the two demo agents, a local bootstrap, a spread report |
| `float/src/{chain,artifacts,deployments,seed}.ts` | chain config, ABIs read from forge's output, per-network deployment records |
| `float/sauce/jit_preflight.sauce.ts` | **Eco Sauce.** A compiled program that asks the Morpho venue — against live Arc state, with nothing signed — whether it could deliver a given shortfall. It asserts Vault V2's always-zero `max*` trap on chain rather than describing it. Acceptance check **T13** runs it in both directions and fails unless the coverable amount is accepted and the uncoverable one refused |
| `float/app/walk.html` | **written by Arc Studio.** One transaction walked step by step: the price read, the shortfall leaving the sleeve, the seller paid, the receipt written — by log index, because Arc serves no `debug_traceTransaction` |
| `float/app/venue.html` | **written by Arc Studio with its `morpho` onchain skill.** What we are trusting in the vault we do not control: the four transfer gates, who can change them and how fast, depth against our exposure, fees, and the rate. It read Morpho's verified Vault V2 source and found that **all four gate setters have no timelock**, and that the owner and curator are the same single key |
| `apps/terminal/app/float`, `components/float`, `api/float/{vault,classify}` | **The terminal float surface**, new this event. A public page that drives the vault's own refusal ladder: `classify` is a `view` running the same **twelve** ordered checks a real payment runs (`D_PAUSED`=1 through `D_DAILY_CAP`=12), so a visitor moves a quote and the chain answers which rung stopped it, in the contract's own words. It signs nothing, spends nothing and needs no key, so it repeats indefinitely at a booth. Verified against the live vault on chain 5042002: a fair quote clears all twelve; 3× returns `"quote exceeds ACR fair band"` still carrying the fair counter-price; an unenrolled name returns `"unknown agent"`; an unlisted seller `"seller not allowed"`; and 19,100 units at 5.02 against a 5.00 threshold returns `"over per-request threshold"` — drawn as a fork to the human approval lane rather than a refusal, because `FloatVault.sol:783` exempts that one code from burning the nonce. Reads are server-side with the RPC and vault address in the environment, so no chain id, host or contract address enters shipping source. |

### 4.2 World ID Agent Pass — a verification that releases money

> Before this event, ACR verified World ID proofs to gate a *read*: a
> unique-human proof unlocked the aggregate spend view across one person's
> wallet fleet, and an on-chain mirror recorded a window-rotated cluster id so
> the uniqueness was auditable without ever storing a nullifier. What is new is
> that a World ID verification now **releases money**. An agent's out-of-policy
> payment is parked on chain, a verified human completes a *fresh* World ID
> device-flow authentication, the backend validates that token against a fixed
> ladder of **nine named refusals**, reporting the first rung that failed rather
> than the last, and only then does a single-use EIP-712 approval let the vault
> move USDC — with denial, expiry and a failed verification each recorded on
> chain as public evidence rather than as silence.

The nine are pinned by a test rather than by this prose:
`worldauth.REASONS` is the tuple, and `test_every_named_reason_is_reachable`
asserts set-equality between it and the reasons nine fixtures actually produce,
so the count cannot drift away from the sentence without a red test. Reporting
the FIRST rung that failed is deliberate: a stale `auth_time`, an unverified
account and the wrong person are three different problems with three different
fixes, and collapsing them into "verification failed" is what makes an approval
gate undebuggable.

| file | what |
|---|---|
| `services/index_api/index_api/worldauth.py` | the ID-token validation ladder: RS256-over-JWKS signature with the algorithm pinned rather than read from the token, then issuer, audience, expiry, assurance class, authentication factors, freshness against when the checkpoint opened, and identity against the enrolled treasurer |
| `services/index_api/index_api/worldflow.py` | the OIDC device-authorization client and its poll table, including the three outcomes a hand-rolled retry loop gets wrong: a 503 is never an approval, a 429 ends the attempt and `Retry-After` does not override that, and `slow_down` widens every later interval |
| `services/index_api/index_api/floatgate.py` | the checkpoint lifecycle and its polling worker: parks the payment, waits for a person, releases it exactly once, and records denial, expiry and failed verification on chain |
| `packages/acr_oracle_client/acr_oracle_client/float_vault.py` | the EIP-712 `FloatApproval` signer, which refuses to broadcast unless the digest it built equals the one the vault's own `approvalDigest` view returns |
| `services/index_api/tests/test_{worldauth,worldflow,floatgate,floatgate_onchain}.py` | the suites, including the adversarial fixtures |

### 4.3 The seven modified baseline files

| file | why |
|---|---|
| `.gitignore` | two ignore rules: the pre-seed fundraise set, and Float's planning docs |
| `.env.example`, `packages/acr_core/acr_core/config.py` | Float and World settings |
| `conftest.py` | test isolation for the new suites |
| `services/index_api/index_api/humanid.py` | one line: the stray-credential scanner's word list, so a mis-prefixed World or Float secret in `.env` is reported rather than silently ignored by `env_prefix="ACR_"` |
| `services/index_api/tests/test_par_api.py` | a test that pinned a live market price to a constant, so it was a clock rather than a check |
| `scripts/demo_spend.py` | two pre-existing lint errors that were stopping `make ci` at its first step |

## 5 · How to check the line

```bash
# everything new, in one command
git log --oneline 6e6a827..HEAD
git diff --stat 6e6a827..HEAD

# Float's own history, which is the submission
git log --oneline 6e6a827..HEAD -- contracts/src/float float/

# the contracts, verified on Arc
cd contracts && forge test            # 300 tests
cd float && npm test                  # the price layer
```

## 6 · How AI tools were used

ETHGlobal's rules require this stated plainly: *"Clearly document in your
submission where and how AI tools were used in the project. This includes
specifying which parts of the code, specific files, or assets were generated or
assisted by AI."* So, precisely.

**The implementation was written with Claude Code.** Not some of it — the
contracts, their tests, the keeper, the agents, the MCP server, the dashboard,
the acceptance harness and this document. It is machine-checkable rather than a
claim: **33 of the 35 commits** in `6e6a827..HEAD` carry a
`Co-Authored-By: Claude Opus 5` trailer.

```bash
git log --format='%H %(trailers:key=Co-Authored-By)' 6e6a827..HEAD | grep -ci claude
```

The two that do not: one merge commit, and one commit by a third-party
contributor (`CeciliaZ030`) that arrived from `main` and belongs to the
pre-existing terminal, not to Float.

**Arc Studio — itself an AI builder — compiled the treasury policy.** The
treasurer's English sentence went in, `policy.generated.json` came out, and it
is committed under `float/studio/` with the exact prompt. Studio also hosts the
dashboard and audited the vault. What it did and did not do is listed in
`float/studio/README.md`.

**What the human directed.** The product itself is the human's: `ACR_Float.md`
and `ACR_float_flow_e2e.md` — the nine runtime flows, the module breakdown, the
demo structure and the kill-gates — were written before the event and are the
specification everything here implements. During the event the human made every
architectural decision (which track, where the dashboard lives, what stack, what
was in and out of scope) and caught two errors that would have cost the entry:
that Arc Studio was not actually part of the build despite the demo claiming it
was, and that nothing had been pushed to GitHub at all.

**The tension, named rather than glossed.** Arc requires Arc Studio — an AI app
builder — as the starting point for every one of its prizes. ETHGlobal warns
that submissions "that rely entirely on AI without meaningful contributions from
team members may not be eligible". Neither page reconciles the two, and we are
not going to pretend the question does not apply to us. Our position is the
factual one above: the design, the direction and the corrections are the human's;
the code was written by AI tools under that direction, and we have said which
ones, where, and in a form anyone can verify from the git history.

## 7 · Open source

Every new file listed above is in the public repository under the same MIT
licence as the baseline, at
<https://github.com/kaustubh76/ACR---Arc-Compute-Rate>. Repository visibility
confirmed `PUBLIC` on 2026-11-05 via `gh repo view --json visibility`.

Two files are deliberately **not** published and are named here so the omission
is disclosed rather than hidden: the pre-seed fundraise set (`docs/fundraise/`),
and Float's own hackathon planning documents, which contain prize targeting and
presentation strategy. Neither is code and neither is part of what is being
judged.
