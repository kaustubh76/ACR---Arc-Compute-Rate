# What Arc Studio did, and what it did not

This directory is evidence, not code. It records the work Arc Studio actually
performed on Float, so the claim can be checked rather than taken.

The honest sentence, which is narrower than "built with Arc Studio" and survives
being questioned:

> Arc Studio compiled the treasury policy from English, audited the vault, and
> deployed the contracts. The rest of Float was written in Claude Code.

## 1 · Compiling the policy from English

This is the product beat, not a demo flourish. A treasurer should not have to
write Solidity, JSON, or a transaction — they should be able to say what the
treasury may do. Arc Studio is the component that turns the sentence into a
configuration; this repository is what refuses it if it is wrong.

**What the treasurer said**, verbatim, and the whole input:

> "Freeze the agent called waster. For everyone else, never pay more than 1%
> above the ACR fair price, keep two days of forecast spend liquid, and keep all
> of the idle float in the working vault."

Studio was given `policy.schema.json` (the contract its output must satisfy) and
`policy.config.json` (the policy currently on chain), and told to change only
what was asked for.

**What it produced** — `policy.generated.json` in this directory, pulled out of
the sandbox with `arc-studio pull`. It changed exactly one field:

```
agents.waster.frozen: false -> true
```

and left `maxPremiumBps` (100), `bufferHours` (48) and `workingShareBps` (10000)
alone, correctly, because they already expressed what the treasurer asked for.
It also left `humanMaxPremiumBps` at 2000 rather than "tidying" it, which matters:
dropping it below `maxPremiumBps` would mean a human approval *narrowing* the
allowed band, and both the schema and the vault refuse that.

**What Studio said about its own output**, which is the reason the next step exists:

> "I didn't run it through a schema validator, but I checked it by eye against
> `policy.schema.json`."

## 2 · Why its output is checked rather than trusted

`float/src/policy.ts` validates every candidate config before a transaction is
built, and an invalid one is refused with the chain left holding the last good
policy. A half-applied policy is worse than an unchanged one, because nobody can
tell which rules are live.

That gate is not aimed at Arc Studio in particular — it would refuse a config
from a human, a script, or a future model just as readily. But a language model
emitting a financial policy is exactly the case it was written for, and "checked
by eye" is exactly the assurance it replaces.

Run it yourself:

```bash
cd float
node --import tsx -e 'import{readFileSync}from"node:fs";import{validate}from"./src/policy.ts";console.log(validate(JSON.parse(readFileSync("studio/policy.generated.json","utf8"))))'
```

Result on this file: **accepted**.

## 3 · The loop, end to end

Measured on a local chain, in this order:

```
apply the policy Arc Studio wrote
  waster.frozen: false -> true          1 transaction
the very next request from each agent
  scout  fair $1.05 quote $1.05525 -> PAID receipt #4
  waster fair $1.05 quote $3.15     -> REFUSED (agent frozen by policy)
```

The refusal *reason* is the thing to watch. Before the policy landed, waster was
refused for `"quote exceeds ACR fair band"` — it was overcharging. After, the
same request is refused for `"agent frozen by policy"`. The policy did not merely
get written; it is what answered.

## 3b · Auditing the vault

Arc Studio read `contracts/src/float/*.sol` and the three Float test suites and
returned a findings report: six invariants assessed, the three questions we put
to it answered, ten findings ranked by exploitability, and a list of categories
where it found nothing. It changed no files; we acted on it.

Recording the triage matters as much as the audit. An audit whose findings were
all dismissed is evidence of nothing, and so is one accepted uncritically.

### Fixed, with a regression test each

| finding | what it was | test |
|---|---|---|
| **F1, high** | `setPolicy`/`setAgent` passed the CALLER's `configHash` into the approval check instead of deriving it, so a signature obtained for "scout's cap becomes 77 USDC" released any later call carrying that hash — a cap a thousand times larger included. The human saw one policy and authorised another, and nothing on chain disagreed. Hashes are now derived on chain (`policyApprovalHash`, `agentApprovalHash`); `configHash` survives only as provenance in the event. | `test_an_approval_for_one_policy_cannot_set_a_different_one` |
| flag (a) | `CheckpointOpened` announced an `agentId` the contract never stored or checked, so the event could name one agent while the request hash committed to another. Our dashboard and the approval signer both read that event. Now stored and compared. | `test_a_checkpoint_opened_for_one_agent_cannot_release_anothers_payment` |
| flag (b) | Status 0 means both OPEN and never-opened. `_consumeApproval` guarded that; `resolveCheckpoint` did not, so a fabricated id could emit a resolution for a decision nobody made. | `test_a_checkpoint_that_was_never_opened_cannot_be_resolved` |
| F2, part | `setAgent` never cleared `guest`, so an id a registrar pre-claimed stayed on the global guest seller allowlist after the owner configured it. | `test_configuring_an_agent_takes_it_off_the_guest_allowlist` |
| F5, part | `paused` blocked writes only, so a bad print kept being served until it aged out and the only remedy was pausing the vault. Reads now report "no print" while paused. | `test_pausing_the_store_silences_its_reads_not_just_its_writes` |
| F10, part | `Erc4626Sleeve.depositIdle` left a standing allowance when the venue pulled less than approved. Cleared after deposit. | covered by the sleeve tests |

### Accepted as true and deliberately not fixed, with the reason

- **F3 — sleeve funds are not reachable while paused.** Real. `withdraw` only
  reaches the buffer and `rebalance` is keeper-only and refuses when paused, so
  pausing blocks its own recovery path. Not fixed here because we deploy with
  `reserve = address(0)`, the owner holds the buffer directly, and adding an
  `unwind` function plus its tests this close to a deadline is more risk than
  the exposure. It is the first thing to add afterwards.
- **F4 — the executor names the `index`.** Real: a 3× quote for a cheap model
  passes if submitted against a dearer model's print. Mitigated only by the cap
  and the seller allowlist. The proper fix allowlists `(agentId, seller, index)`,
  which is a storage redesign. The executor is our own key, and this is stated
  as a trust boundary rather than quietly carried.
- **F5 — no deviation bound on a new price, and no way to invalidate one.**
  Real. One signer can post any price and collapse the band. The keeper is our
  key, and pausing the store is now an effective lever, which it was not before.
- **F6 — a reverting venue breaks spends with no `Denied` event**, and
  **F8 — the executor can resolve any open checkpoint**, including writing
  EXPIRED over one a human already signed. Both real, both bounded by the same
  trust we already place in those two keys, both stated rather than fixed.
- **F9 — the daily cap is a fixed window, not rolling.** Intended. "Daily" here
  means per period, and `_rolled` aligns to whole periods on purpose.
- **F7 — `NullSleeve` as the reserve bricks `rebalance`.** Not applicable: we
  deploy with no reserve, and `NullSleeve` exists only as a test double.

### One claim it corrected

We had asserted that vault-plus-sleeve value decreases **only** by the amounts in
`Receipt` events. That is false, and the audit was right to say so: the owner's
`withdraw` moves money with no Receipt, each park loses a rounding unit to the
venue's floor, and a venue can lose value on its own. The invariant we can
actually defend is narrower — *no path pays USDC to a registered agent, and no
agent exceeds its daily cap* — and that is what the tests pin.

### What the audit's own fix broke, caught by a second reviewer

Not an Arc Studio finding, and recorded here rather than in the table above for
that reason: this came from a peer session reviewing the commit that fixed
flag (a). It is the more interesting half of the story, because the fix for one
misleading refusal introduced another.

Storing and comparing `agentId` meant adding a guard to `executeApproved`, and it
went in **above** the existence check that `_consumeApproval` already carried:

```
FloatVault.sol:912   require(checkpoints[id].agentId == r.agentId, "agent mismatch");
FloatVault.sol:935   require(c.reqHash != bytes32(0), "no such checkpoint");
```

An id nobody opened has `agentId == bytes32(0)`, which never equals a real
request's — so the comparison fires first and `"no such checkpoint"` became
unreachable from `executeApproved`. Nothing moves either way; the cost is that
someone debugging a fabricated id goes hunting an agentId derivation bug. The
sting is that `_consumeApproval`'s own comment warns about precisely this
failure, two lines above the check it was protecting.

The fix is a two-line hoist, and it is **deliberately not applied**:

```solidity
require(checkpoints[id].reqHash != bytes32(0), "no such checkpoint");
require(checkpoints[id].agentId == r.agentId, "agent mismatch");
```

`FloatVault.sol` last changed 22 minutes before the Arc testnet deploy, so the
deployed bytecode matches this source exactly and the contracts verify on
Blockscout as they stand. Editing the source alone breaks that match for a
revert string; redeploying burns a one-shot `wire()` and discards live receipt
history. So it is stated here instead, and it is the first thing to land after
the deadline. The reviewer's test pins the current, wrong message on purpose,
with a comment recording why — so reordering the guards turns that test red and
announces itself rather than passing quietly.

## 4 · What Arc Studio did not do

Stated plainly, because a vague claim collapses under one question and a narrow
one does not:

- It did not write `FloatVault.sol`, `FloatPrintStore.sol`, the sleeves, or their
  80 tests.
- It did not write the keeper, the agents, the MCP server, the policy validator,
  or the acceptance harness.
- It did not author the dashboard. It **hosts** it — `index.html` was written in
  Claude Code and Studio serves it byte-for-byte. That is checkable rather than
  asserted:

  ```bash
  shasum -a 256 float/app/index.html
  arc-studio cat --app b5aa43e1-4d5c-4d47-b079-dcc9aea0e557 index.html | shasum -a 256
  ```

  Both print `315f2f2d6ff62485280c5850cb0ff3ca37b27ea5533f855ff14a438adb220c87`
  (14,636 bytes, 304 lines). The file was delivered with `arc-studio run -f
  'float/app/index.html:index.html'`, which places a file in the workspace
  instead of asking the model to retype it — the only way the claim above can
  be true. Studio was told not to reformat or "improve" it, and did not.
- It did not touch the World ID gate, which belongs to a separate workstream and
  was written outside Studio.

See `hackathon/ethglobal-mumbai-2026/CONTINUITY.md` for the full attribution,
including which parts of this repository were authored with AI assistance, as
ETHGlobal's rules require.
