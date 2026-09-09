# Module W — World / AgentKit: the design, and the two decisions that cannot be taken back

*Measured on `feat/graph-machine-tca`, 2026-09-05: 445 pytest (0 skipped), 114 forge, all green.*

Companion to `GRAPH-RUNBOOK.md`. That document is an operator sequence for work already built.
This one is different: Module W is **not built yet**, and two of its decisions are irreversible
once shipped, so the design has to be settled before the first contract is written rather than
after.

Read the two warnings first. They are the only ways this module can cost something that cannot
be recovered.

> **Never publish a raw World ID nullifier on chain.** The obvious mirror —
> `HumanIdResolved(wallet, humanId)` — publishes a durable nullifier against every wallet in a
> human's fleet. A public chain has no delete. This is the same class of mistake as repointing
> `ACR_ORACLE_ADDRESS`, and it is why the identity design below is W1's design and not a later fix.

> **Resolve humans before the tape drive.** `Settlement` is `@entity(immutable: true)` and
> `Settlement.human` is stamped at finalize time from whether the payer had a cluster then. A
> payer that trades before its resolution is indexed as non-human permanently, its volume never
> reaches `humanVolume`, and no later resolution repairs it.

---

## 0 · Where the project stands

Ten commits on `feat/graph-machine-tca` shipped **Module G in full**: `ReceiptMirror.sol` +
`ACROracleV2.sol`, the `acr-tape` subgraph (schema, 8 mappings, 5 mapping test files),
`graph_source.py`, `tca.py` with `payer_tca` / `seller_rating` / `_reroute`, a priced
multi-seller `fleet.py`, the MCP server with 6 tools, the `acr-analyst` skill, and the
`recompute` / `mirror-receipts` / `backfill` scripts.

`ACROracleV2` already solved the hardest structural problem: it carries `humanAdjustedBound` and
is deployed *alongside* v1 with v1's six signed fields as a strict typehash prefix, so the
immutable `ACRFutures.oracle` is never orphaned and one signing path serves both generations.

Three gaps remain, in priority order.

**Gap 1 — deployment. CLOSED 2026-09-05.** ACROracleV2, ReceiptMirror and the
`acr-tape` subgraph are live on Arc testnet with real addresses and start blocks;
`ACR_SUBGRAPH_URL` is set and the tape reproduces the hand computation. The
paragraph below is kept because it explains why that mattered, and because
`HumanIdMirror` now faces the same step from the other side: adding a data source
to a LIVE subgraph means a new Studio version and a full re-index, so its address
and start block have to be filled in before `make graph-deploy` will run.

**Formerly Gap 1 —** `.env` has none of `ACR_ORACLE_V2_ADDRESS`,
`ACR_RECEIPT_MIRROR_ADDRESS`, `ACR_SUBGRAPH_URL`, `ACR_GRAPH_API_KEY`; `graph/subgraph.yaml`
still carries `0x0` placeholders and `startBlock: 0` for both new data sources. The Graph's
bounty requires **live** Studio data and explicitly rejects "mocked, local-only, or static
datasets", so until `GRAPH-RUNBOOK.md` is executed the strongest-built module scores as unbuilt.
This outranks everything below.

**Gap 2 — Module W does not exist.** This document.

**Gap 3 — submission artifacts.** No `CONTINUITY.md` (a Continuity-track *rules* requirement),
no `FEEDBACK_WORLD.md` (an explicit World deliverable, four named headings), no
`docs/SPIKE-LOG.md`, no `specs/`.

---

## 1 · What Module W actually has to supply

Everything downstream is already built and waiting on **two inputs**: a number and an identity.

| Already built, waiting | Waiting on |
|---|---|
| `ACROracleV2.sol:49` — the `humanAdjustedBound` field and its invariant | a number |
| `client.py:54` `PostPayload.human_adjusted_bound`, `types.py:112` `ACRPrint.human_adjusted_bound` | a number |
| `graph/src/oracle.ts:48` — zero-as-sentinel, stored null | a number |
| `graph/src/mirror.ts:135` — `s.human = …` | an identity |
| `graph/src/rollup.ts:78` — `humanVolume` accumulation | an identity |
| `graph/src/parties.ts:55` — `distinctHumans` | an identity |
| `services/index_api/index_api/tca.py:177` — the `human_depth` rating component | an identity |

Supplying the identity moves `weight_covered_pct` on every seller rating from **55% to 75%**:
`fairness` (40) and `attestation_freshness` (15) are live today; `human_depth` (20) is excluded
from the normalisation rather than scored zero. That is a measurable improvement in what a grade
rests on, not a claim about it.

---

## 2 · Decision one — what goes on chain

The mirror publishes a **window-rotated cluster id**. The nullifier never touches *Arc*.

```
clusterId = keccak256(abi.encode(nullifier, SERVICE_SALT, window))
window    = floor(blockTime / RATING_WINDOW)          // RATING_WINDOW = 7 days

event HumanClusterResolved(
    bytes32 indexed clusterId,
    address indexed wallet,
    uint64  indexed window,
    address resolver
)
```

Contract shape follows `FeedAccessAttestor.sol`, the house template for an additive contract:
resolver-signed EIP-712 so any relayer may submit, two-step ownership, pause, and a public digest
view so an off-chain signer can be checked against the chain's own arithmetic.

* **Idempotent.** Re-recording the same `(wallet, window)` is a no-op, not a revert. The keeper
  reruns; a rerun must not be an error.
* **Rebinding within a window reverts** unless the owner overrides, emitting
  `HumanClusterRebound`. This is the farm-churn defence and the contract's actual reason to
  exist. Across windows a new cluster id is expected and normal — that is rotation working, not
  a rebind.

### What rotation does and does not buy

Rotation does **not** unlink a fleet. Wallets are the join key and they do not rotate:

```
window 1:   (A,X) (B,X) (C,X)
window 2:   (A,Y) (B,Y)

A appears under X and under Y  ⇒  X and Y are the same human
```

The equivalence class is transitively closed through wallet addresses, so any wallet that recurs
across windows chains the clusters together. Anyone claiming otherwise will be corrected by a
judge in about two minutes, and the correction will be right.

What rotation *does* buy is real and worth shipping: **the durable nullifier is never published
on Arc**, so nobody can join ACR's tape to another service's data keyed by the same World ID.
That is cross-service correlation resistance, and it is the claim to make:

> Rotation prevents correlating your World ID across services. It does not hide, within ACR's own
> tape, that these wallets act together. Doing that needs aggregate-only publication or a
> zero-knowledge proof of cap compliance, and is named here as future work rather than implied as
> done.

**Narrower still, and this was found late.** World's own AgentBook publishes
`wallet -> nullifier` on World Chain — I read the live contract to confirm it. So a registered
fleet is **already public there** to anyone scanning `AgentRegistered`, and no design on Arc could
change that. The claim is therefore not "we keep fleets private"; it is that ACR's tape does not
become a *second* publication of the durable identifier, keyed to our own settlement data. We
neither add to AgentBook's disclosure nor depend on it having been private. Every surface carrying
the shorter version of this claim — the contract header, `schema.graphql`, `humanid.ts`,
`humanid.py` — was corrected rather than left to read as more than it is.

The keeper knows the nullifier-to-cluster mapping and could publish it. That places this
alongside the other keeper-authored, trust-required facts already listed in the trust boundary —
stated, not hidden.

**Fleet-level TCA is computed off-chain only**, in the API, against a live AgentKit proof, for the
duration of one verified request. The union exists nowhere else. That is the half of the privacy
property the chain cannot provide.

---

## 3 · Decision two — the rotation period, and what it does to the schema

**Rotation is aligned to the rating window (7 days), not the print window.**

Prints are hourly. Rotating per print would give one human up to 168 cluster ids a week, so
counting distinct clusters would overcount distinct humans by up to 168x and feed nonsense to
`tca.py`'s `human_depth`. Aligning rotation to the rating window makes distinct-cluster-count
equal distinct-human-count exactly, over precisely the window the rating already uses. The longer
window is also the honest trade: more rotation is more privacy theatre, not more privacy, given
the linkage argument above.

### Schema consequences

Free to make — nothing is deployed yet. Once the subgraph ships, adding a data source forces a
full re-index from every `startBlock`, so these land now.

* **`Seller.distinctHumans` is gone as a lifetime counter.** It was incremented once per
  `(seller, payer)` link inside `linkSellerPayer`, so it could not see a late resolution and could
  not express a per-window count. Under rotation it would also have counted the same person once
  per window and climbed forever.
* **`SellerWindow`**, keyed `"<seller>-<window>"` — the SellerDay id idiom — carrying
  `distinctHumans`, `distinctPayers`, `humanVolume`, `volume`. This is what `seller_rating` reads.
* **`SellerWindowPayer` and `SellerWindowHuman`**, both `@entity(immutable: true)` and both pure
  set membership, mirroring the existing `SellerPayerLink` idiom verbatim — a mapping cannot hold
  state between handlers, so the store is the only memory it has. Two entities rather than one
  because the ratio `distinctHumans / distinctPayers` is only meaningful when both sides are
  counted over the same window.
* **`HumanCluster`**, keyed on the cluster id, with `window`, `walletCount` and a `wallets`
  back-reference. `walletCount` is what makes "two wallets, one human" checkable.
* **`Payer.cluster` + `Payer.clusterWindow`** — the current window only — plus `resolvedLate` and
  `lastSettledWindow` (see below).
* `mirror.ts` now asks "does this payer hold a cluster for *this* window", not "is `humanId`
  non-null".

Two mapping tests were mandatory, because they are the two bugs this design exists to prevent:
**resolution-after-trade**, and **rotation across a window boundary**. Both are in
`graph/tests/humanid.test.ts`, alongside the fleet case — which settles from a *second* wallet, so
it proves a fleet is counted once rather than merely proving one wallet is counted once.

**`resolvedLate` is exact, not approximate.** `Payer.lastSettledWindow` is stamped at finalize, so
the resolve handler can tell "this payer already traded in the window I am only now resolving it
for" from the ordinary case of a payer that traded in some earlier window. Without it, every
second-window resolution for an active payer would raise the flag and the flag would mean nothing.

**Nothing is repaired, deliberately.** A late resolution could in principle walk the payer's
settlements and fix `distinctHumans` — but `Settlement.human` is immutable and `SellerDay.humanVolume`
derives from it, so the count would then disagree with the rollup it is published beside. Two
contradictory numbers are worse than one honest flag. This follows the schema's own `staleArrival`
doctrine: *"a FLAG, not an exclusion: the mapping records and the reader decides, because a mapping
cannot be re-run."*

---

## 4 · Decision three — the number

`packages/acr_estimator/acr_estimator/human_caps.py`. Mostly composition:
`bound.manipulation_bound` already accepts `cluster_cap` and `raw_total` and already returns
`sybil_clusters_required` and `min_identities`. Module W supplies a cluster-key function — the
cluster id when resolved, else the existing Louvain funding cluster — and two caps: `c_h = 0.08`
verified, `c_u = 0.03` unverified.

Four constraints, each with a test:

1. **The enrolled human set is an argument, not a global.** Recomputing the bound with one human
   removed then has to be a function call. The demo beat that shows a human un-enrolling and the
   bound visibly dropping depends entirely on this — a five-minute decision now versus a rewrite
   later.
2. **Clamp to the on-chain invariant.** `ACROracleV2.sol:210` enforces
   `humanAdjustedBound == 0 || humanAdjustedBound >= attackCostPerBp`. Removing a human lowers the
   bound; if it crosses below the wallet bound, the next `postPrint` **reverts and the feed
   breaks** — on camera, during the demo it was built for. Clamp, and test the clamp.
3. **Bump `POLICY_VERSION` to 2** and fold the human caps into `policy_hash()`. That function's own
   docstring requires the hash to cover everything that can change an exclusion, and changing the
   cluster key changes exclusions. Without the bump a re-derivation would silently disagree with
   the keeper for reasons the hash claimed were impossible.
4. **`make eval-gate` must not move.** Capture its four figures on a clean tree *before* this change
   and require them unchanged after. That is the proof the human cap did not perturb the published
   index. Do not trust a remembered baseline; measure it.

`C_human` — the cost of acquiring one verified identity — is an assumption, not a measurement. It
is a named constant covered by `policyHash`, and the published headline is the **count** of humans
required, which is computed, rather than a dollar figure, which is chosen.

---

## 5 · Decision four — where the proof is verified

`services/index_api/index_api/humanid.py`, structurally mirroring `x402.py`.

The x402 gate in this codebase is a **FastAPI dependency** — `require_payment` at `x402.py:536`,
composed per-route in an ordered `Depends` list — not wrapper middleware. `withGateway()` is a
buyer-side symbol from `@circle-fin/x402-batching` and does not exist server-side at all. So the
AgentKit verifier is a **sibling dependency**, which is the cheapest possible landing and retires
the spike that was going to decide whether this module was feasible.

`HumanProof` dataclass · `HumanVerifier` ABC · `DevHumanVerifier` (no network, mirrors
`DevFacilitator`) · `AgentKitVerifier` (fail-closed to 401 on every error path, the discipline
`CircleFacilitator` already applies) · `get_/set_/reset_human_verifier` singletons, because the
reset function is what the tests depend on · `require_human` setting `request.state.human` beside
`request.state.payment` · route `GET /tca/human`.

| Property | Failure it prevents |
|---|---|
| Challenge nonce single-use and TTL-bounded | replay |
| Proof binds resource, chain id, app id, expiry | cross-context replay |
| **Wallet set comes from AgentBook, never the client** | a caller unions arbitrary wallets and reads someone else's spend |
| Only the nullifier is retained; wallets are request-scoped | §2's privacy claim becoming false in the API |
| Nullifier masked in every log and error (see `_short_addr`, `app.py:514`) | logs are read on stream |
| Verifier failure never degrades to "unverified but allowed" | fail-closed |

Config goes on `ACRSettings`, never raw `os.environ` — the raw path is import-time frozen and
untestable through the `monkeypatch.setenv` + `reset_settings()` pattern the suite uses. The root
`conftest.py` strips every `ACR_*` variable, so each test sets its own.

Rate limiting is keyed on the nullifier through the existing `ratelimit.py` budgets. That is the
bounty's "rate limits" line item delivered as behaviour rather than prose, and per-identity is the
correct key: an IP-keyed limit behind a proxy is a global limit.

---

## 6 · Build plan

| # | Item | Est. | Done means |
|---|---|---|---|
| W0 | ✅ This document | 1h | the two irreversible decisions are reviewable before code |
| W1 | ✅ `HumanIdMirror.sol` + rotated cluster ids + schema redesign + mappings + tests | 7h | **done 2026-09-05**: 28 forge + 12 matchstick, all green. Not yet deployed — see §7 |
| W2 | `human_caps.py` — parameterised, clamped, `POLICY_VERSION` 2 | 5h | a real `humanAdjustedBound` posted; eval-gate unmoved |
| W3 | ✅ `humanid.py` verifier + `require_human` + `GET /tca/human` | 5h | **done 2026-09-06**: 28 tests; replay returns 401, no wallet list in any response |
| W4 | ✅ `my_tca("me")` in MCP + AgentBook read client + `resolve_humans.py` | 4h | **done 2026-09-06**: 5 anvil tests + 12 agentbook + 5 MCP; a fleet resolves and counts once |
| W5 | `CONTINUITY.md`, `FEEDBACK_WORLD.md`, `SPIKE-LOG.md`, `specs/` | 4h | a stranger can retrace the build |
| W6 | AgentKit-to-Gateway adapter, in-repo | 3h | one example service runs |
| W7 | "secured by N verified humans" — API field + README | 2h | renders the true N with its caveat |
| W8 | `standard/STANDING.md` v0 + a second service honouring it | 3h | upside only; do last |

### What W1 landed

`contracts/src/HumanIdMirror.sol` and its 28 forge tests · `DeployHumanIdMirror.s.sol` and the
`make deploy-humanid[-dry]` pair · the `HumanIdMirror` ABI in `scripts/graph_abis.py` · the schema
above · `graph/src/humanid.ts` and the changes to `parties.ts` / `mirror.ts` · a seventh data source
(placeholder address, so `make graph-deploy` refuses until it is filled) · 12 matchstick tests ·
`tca.py` reading `SellerWindow`, refusing a mixed-window grade, and reporting `human_share` ·
`tests/test_human_window_parity.py`, which pins the rotation window across Solidity, AssemblyScript
and Python by reading the other two off disk.

Suites after W1: **458 pytest · 147 forge · 52 matchstick**, and `verify_claims.py` green with the
counts updated in lockstep.

### What W3 landed

`services/index_api/index_api/humanid.py` — the verifier, mirroring `x402.py`'s challenge/verify
seam, module singleton and fail-closed discipline · `GET /tca/human` (registered **before**
`/tca/{payer}`, or FastAPI binds `payer` to the literal `"human"`) · `GET /humanid/info` ·
`human_tca` in `tca.py`, with the per-seller aggregation extracted so a wallet and a fleet share
one implementation and the reroute sees the fleet as **one book** · a `"humanid"` rate-limit
budget keyed on a hashed nullifier · 28 tests in `test_humanid.py`.

`packages/acr_oracle_client/acr_oracle_client/humanid.py` is now the single Python definition of
both the rotation window and the cluster-id derivation; `tca.py` imports the window rather than
keeping a second copy. `abi.encode` of three static types is just three 32-byte words, so no
`eth_abi` dependency was needed — and `Web3.solidity_keccak` is explicitly *not* used, because it
packs the `uint64` into 8 bytes and would fail only against the chain.

**Two design points that moved during implementation, both toward less exposure:**

* **`HumanProof` carries no wallet list.** The route hands a *cluster id* to the tape and the tape
  answers, so no fleet is ever held in the API and the response reports only `wallet_count`. That
  makes "only the nullifier is retained" literally true rather than aspirational.
* **The salt/commitment check is configuration, not a chain read.** `ACR_HUMANID_SALT` must hash
  to `ACR_HUMANID_SALT_COMMITMENT`; a mismatch fails closed with 503 and is reported on
  `/humanid/info`. A wrong salt derives cluster ids that match nothing, so without this the
  failure mode is an empty union that reads exactly like "this human has never traded" — a silent
  zero, which is the one answer a benchmark must never give by accident.

Cross-implementation parity is pinned by a fixed vector: `HumanIdMirror.t.sol` computes
`keccak256(abi.encode(nullifier, salt, window))` in Solidity, and
`tests/test_human_window_parity.py` reads that expected value off disk and asserts Python derives
the same bytes — plus a test proving the packed encoding genuinely differs, so the parity test is
discriminating rather than passing for both.

Suites after W3: **490 pytest · 149 forge · 52 matchstick**, `verify_claims.py` green.

### What W4 landed

`scripts/resolve_humans.py` and `make resolve-humans` — the bounty's *"keeper resolves wallets →
HumanIdMirror"* line item, which `deploy-humanid` had been promising in its echo block since W1 ·
`HumanIdMirrorClient` beside the cluster-id derivation, mirroring `MirrorClient` ·
`agentbook.py` with a fixture roster and an (unexercised) World Chain reader ·
`demo_humans.py` — two humans over four wallets, 3+1, because with one wallet each
`distinctHumans` always equals `distinctPayers` and nothing shows why grouping matters ·
`my_tca("me")` in the MCP plugin · a `humans` canned tape operation.

It also closed two gaps W1 left: `humanid_mirror_address` was documented in `.env.example` but had
no settings field behind it, and `resolve-humans` was referenced by a make target that did not
exist.

**Provenance went on chain, which was only free before deployment.** `HumanIdMirror.record` now
carries a `sandbox` flag through the signed message, the event, and `clusterProvenance`, with the
invariant that **a cluster's provenance can never flip** — otherwise a resolver could launder a
demo identity into a verified one and move a published number without moving anything real. The
tape carries `HumanCluster.sandbox` and `SellerWindow.sandboxHumans`, and `human_depth` reports a
`sandbox_share` exactly the way every rating already reports its synthetic share. `synthetic` is
grader-controlled *flow*; `sandbox` is a non-Orb *identity*; both are disclosed rather than
trusted.

**Three things the implementation found:**

* **`ownerRebind` could mint a cluster nothing had established.** A rebind carries no provenance,
  so the mapping would have created one defaulting to "not sandbox" — an unearned claim. The
  contract now refuses a rebind into an unrecorded cluster, and the handler loads clusters rather
  than creating them.
* **The resolver must read the window from the chain, not its own clock.** `record` compares
  against `block.timestamp`; a drifted host would sign for the wrong window and every call would
  revert for a reason that looks nothing like the cause.
* **A proof cannot be a static credential.** The challenge nonce is single-use, so `my_tca("me")`
  takes a fresh challenge and answers that one. The plugin cannot mint a real AgentKit proof at
  all — that comes from the agent's own World credential — and it says so rather than returning
  something that looks verified.

The pre-broadcast check is stronger than `MirrorClient`'s: it compares our EIP-712 digest against
the contract's own `resolutionDigest` view, so agreeing with ourselves is not mistaken for
agreeing with the chain.

Suites after W4: **555 pytest · 156 forge · 57 matchstick · 13 MCP**.

**Floor if time runs short: W0 + W1 + W2 + W3 + W5.** Those are what make the track claim true.
W6 and W8 are what make it memorable.

**On W6, before opening any pull request.** Two preconditions, both unmet today: confirm that
`worldcoin/agentkit` exists as a public repository accepting external PRs — **this has not been
verified; check it rather than assume it** — and exercise the adapter against at least one real
Sandbox proof. A pull request into a sponsor's own repository containing code that never ran
against their live verifier is read by the person who maintains it. If Sandbox has not landed,
ship the adapter in this repo labelled *proposed upstream, not yet exercised against live
Sandbox*: same visibility, no downside.

**On W7, the number in the headline.** Render the true N with its caveat inline. A Sandbox demo
has roughly four identities unless the tape drive recruits real people. "Secured by 4 verified
humans (Sandbox)" is credible; a headline of 19 that turns out to be 4 is fatal in a repository
that runs `verify_claims.py` precisely because numbers drift. The Terminal surface and the
embeddable badge are **UI**: they cost the `coverage.test.ts` ledger and the `chain.test.ts`
key-order assertions. Take that cost knowingly or defer it; do not discover it.

**On W5's feedback document**, written as contribution rather than complaint: the Gateway adapter
gap (with W6 attached), Developer Portal gaps for proofs gating *authorization amounts* rather
than access, Sandbox edge cases (proof expiry across services, replay for spend-authorization,
per-nullifier limits, multiple wallets per sandbox human), and one proposed API extension —
**scoped spend attestations** ("this human authorizes this agent to spend up to X at service Y"),
which the budget-authority flow currently reconstructs by hand.

---

## 7 · Deploy sequence — seven steps, two irreversible

The `GRAPH-RUNBOOK.md` five, with two inserted. Order is load-bearing.

1. `make attest-once && make snapshot` — attest the seller fleet
2. `make deploy-mirror` — ReceiptMirror; record address **and** startBlock in `.env` and
   `graph/subgraph.yaml`
3. **`make deploy-humanid-mirror`** — before any tape exists
4. `make graph-deploy` — Studio, every data source non-placeholder; record `_meta.block` against
   RPC head and `hasIndexingErrors` in `docs/SPIKE-LOG.md`
5. `make deploy-oracle-v2` — **leave `ACR_ORACLE_ADDRESS` on v1**
6. `make backfill-oracle-v2` — **irreversible**, and must precede v2's first live post
7. **`make resolve-humans`** — before the tape drive, per warning two

Then the tape drive, then `make verify-live`, `make recompute`, and
`make recompute -- --rederive-cleaning`.

**If W1 slips:** deploy 1–2 and 4–6 without the human mirror to lock in live Studio data, then
redeploy the subgraph with the seventh data source. The cost is a full re-index plus permanently
non-human settlements from the first wave — acceptable only because those predate Module W anyway.

---

## 8 · Day map (Sep 5 → Sep 13)

| Day | Work |
|---|---|
| **Sep 5** | W0 this document · W1 mirror, schema redesign, mappings, forge + mapping tests |
| **Sep 6** | W2 `human_caps.py` · W3 `humanid.py` |
| **Sep 7** | **Deploy day** — seven steps, live Studio, SPIKE-LOG written |
| **Sep 8** | Resolve humans → tape drive → confirm `human_depth` lights up and `weight_covered_pct` rises · `/tca/human` end to end |
| **Sep 9** | W4 · W6 adapter in-repo · the reroute loop closing on camera |
| **Sep 10** | W5 docs · W7 metric · doc-counter lockstep · **scope freeze EOD** |
| **Sep 11** | Buffer · W8 if green, else Arc mainnet readiness |
| **Sep 12** | Video, incl. the World beat: sybil side-by-side → un-enrol → standing → adapter |
| **Sep 13** | Submit |

---

## 9 · Checking it worked

```bash
make lint && make test-py && make test-contracts && make graph-test && make test-mcp
make eval-gate            # four figures unchanged across W2
make verify-claims        # the doc counters, in lockstep
```

`make test-py` must report **zero skips** — CI treats a skip in the anvil-backed suites as a
failure.

Live, after deploying:

```bash
curl -s -X POST $ACR_API/graph/query -H 'content-type: application/json' \
  -d '{"operation":"meta"}'          # _meta.block near head, hasIndexingErrors false
make recompute                        # within the on-chain CI
make recompute -- --rederive-cleaning # exclusions match the keeper
curl -s $ACR_API/rating/<seller>      # human_depth.available true, weight_covered_pct risen
curl -s $ACR_API/tca/human -H 'HUMAN-PROOF: …'   # replaying the same proof returns 401
cast call $ACR_ORACLE_V2_ADDRESS …    # humanAdjustedBound non-zero and >= attackCostPerBp
```

**Audit the mirror before the video is cut.** Grep every emitted log and every indexed entity for
a raw nullifier. The expected result is zero hits. If that grep ever returns something, §2's claim
is false and the README is lying.

### The doc-counter lockstep

`verify_claims.py` re-measures suite counts and asserts them against hardcoded document paths and
prose greps. Adding tests is therefore never a code-only change: `docs/SUBMISSION.md`,
`docs/IMPLEMENTATION_STATUS.md`, `docs/MVP_STATUS.md`, `docs/presentation.md`,
`docs/pitch/deck.html`, `docs/SUBMISSION-BRIEF.md`, **and both count cards inside
`acr_architecture.excalidraw` plus the regenerated SVG** all move together. New contract addresses
must appear in `SUBMISSION.md` or `IMPLEMENTATION_STATUS.md`.

Per commit that adds tests: `make diagram && make deck && make pitch && make verify-claims`.

`CONTINUITY.md` should register its counts *in* `verify_claims.py` rather than stating unchecked
numbers. An unverified number in the one document a judge reads for honesty is exactly the drift
that file exists to kill.

---

## 10 · What stays unfinished, deliberately

* **Within-tape fleet linkage is not hidden.** §2 says why, and says what would fix it. Stated as
  a limit, not implied as solved.
* **Historical settlements keep the human flag they were stamped with.** `Settlement` is
  immutable. A resolution cannot reach backwards, and pretending otherwise would mean mutable
  history in a benchmark.
* **Cleanliness stays excluded from seller ratings** until re-derived wash flags exist on the
  tape. Excluded from the weighting, never scored zero; every rating carries `weight_covered_pct`
  so a reader knows what the grade rests on.
* **The Sandbox is the honest limit of "verified human" in this demo.** Say so in the README, and
  say what changes at mainnet with Orb-verified users.
* **Third-party standing is upside, not a claim.** The specification and our own second service
  are the deliverable, honestly labelled as ours. No partner is named until they have actually
  integrated.
* **Arc mainnet is a separate block of work.** Chain id 5042 appears nowhere in this repository;
  there is no mainnet RPC, explorer, USDC address, or `deploy-mainnet` target, and
  `gen_snapshot.py:253-259` refuses to embed oracle data from any chain id other than 5042002.
  Arc's bounty accepts "deployment-ready by 30 September" — that is the honest route, not a rushed
  mainnet push before submission.

---

## 11 · The one external dependency

World Sandbox access. W1, W2 and W3 are all buildable and testable without it — the dev verifier
backend exists for exactly that reason — but W4, W6, W7 and the un-enrol demo beat all need real
enrolled identities. **Request it first, before any of the work above**, because it is the only
item on this page that cannot be made to go faster by working harder.

Because the verifier seam turned out to be a FastAPI dependency rather than middleware surgery
(§5), the fallback to the Ledger track remains a decision rather than a redesign.
