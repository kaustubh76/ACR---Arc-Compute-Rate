# What Arc Studio did, and what it did not

This directory is evidence, not code. It records the work Arc Studio actually
performed on Float, so the claim can be checked rather than taken.

The honest sentence, which is narrower than "built with Arc Studio" and survives
being questioned:

> Arc Studio compiled the treasury policy from English, audited the vault, and
> wrote two of the three pages — the transaction walkthrough and the venue risk
> page. The contracts were written and deployed in Claude Code, and so was
> everything else.

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

**`policy.generated.json` is a record of that turn, not a mirror of the chain.**
Diff it against `float/policy.config.json` today and you will find *two*
differences, not the one above: the agents' `dailyCapUsdc` reads `25` here and
`60` there. Studio did not touch it — the cap was raised afterwards, in Claude
Code, because the demo tape pays $1.055 every half hour out of the same daily
allowance the acceptance suite's T2 and T5 spend from, so at $25 the payment
checks only passed in the first half of each 24-hour period. The reasoning is in
`float/README.md`. Said here because the alternative is a judge finding a second
diff and reasonably wondering what else moved quietly.
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
deployed bytecode matches this source exactly — and that is no longer our claim
to make. **All four contracts are now verified on Blockscout**, which only
verifies on an exact match, so the explorer attests it independently of
anything written here. Editing the source alone breaks that match for a
revert string; redeploying burns a one-shot `wire()` and discards live receipt
history. So it is stated here instead, and it is the first thing to land after
the deadline. The reviewer's test pins the current, wrong message on purpose,
with a comment recording why — so reordering the guards turns that test red and
announces itself rather than passing quietly.

## 3c · Writing the transaction walkthrough

`walk.html` in the Studio app — **Arc Studio wrote this one**, and it is the
clearest case in this file of Studio doing work rather than hosting it.

The brief was a spec, not a prompt: the chain and addresses, the `Receipt` and
`Pulled` event signatures, Arc's 10,000-block `eth_getLogs` cap, the four steps
to render, the style tokens to copy out of `index.html`, and two traps stated in
advance — that USDC emits several `Transfer` events in this transaction because
the venue's withdrawal path emits its own, and that step one has no log at all.
Studio found the newest just-in-time payment itself by paging backwards, decoded
the transaction, and laid out the four steps.

**It was checked against the chain rather than taken on trust.** Every figure the
page displays was derived independently with `cast` first, and all of them match:

| the page says | the chain says |
|---|---|
| print `#3`, fair `$1.05`, quoted `$1.05525`, `+50 bps` | `Receipt` data: printId 3, units 4000, quote 1055250 |
| log **28** · `Pulled` requested `$0.55525` = delivered | log 28, sleeve, `Pulled(555250, 555250)` |
| log **30** · `$1.05525` to the seller | log 30, USDC, from vault → `0xf4e89e34…`, 1055250 |
| log **31** · `Receipt #7`, just-in-time | log 31, vault, id `0x7` |

Two things it got right that are the reason the spec named them. It matched the
seller's payment on `to == seller` and says so on the page — "USDC emitted 4
Transfer events in this transaction, because the venue's withdrawal path emits
its own. This one is matched on `to = seller`, not on position or size" — and
four is the correct count. And it refused to invent a log for step one:

> This step has no log. Reading the price feed is a staticcall inside the
> transaction, and staticcalls emit nothing. What proves it is stronger: the
> Receipt names the exact print it was checked against, so the payment commits
> to its own price.

It also surfaced the number that makes the beat land, which the spec asked for in
words but did not compute: the vault pulled `$0.55525` against a `$1.05525`
payment, because `$0.50` was already liquid in the buffer. It pulls the
**shortfall**, not the payment. The parked buffer plus the sleeve pull equals the
payment to the cent, and none of those three figures is round.

**What we changed afterwards.** For a long time, nothing. The dashboard needed
two links added to reach it — one above the tape and one per paid row carrying
that row's `?tx=` — because the Studio preview panel has no address bar, so a
page nothing links to cannot be opened there at all.

Later, one thing inside the page: its `retry()` was
`try { return fn() } catch { return fn() }` — a single immediate retry of
*anything*. That retries a revert as eagerly as a rate limit, learning the same
failure twice, and an instant retry is no use against a limiter that wants you
to wait. It now backs off, and only for a rate limit. Worth recording because
the page Studio wrote with the `morpho` skill (§3d) had the better instinct
unprompted — `batch: { wait: 25 }, retryCount: 5, retryDelay: 700` on its
transport, which we discovered only when a patch to add batching found it
already there.

## 3d · The Morpho onchain skill, pointed at the venue we actually use

`venue.html` — **Arc Studio wrote this one too**, with its `morpho` onchain
skill (`arc-studio run --skills morpho`). Studio's skills are a first-class
feature of the product, so using one is a fairer demonstration of Arc Studio
than another page of ours that it merely hosts.

The brief was deliberately not "show the yield". Float parks its idle float in a
Morpho vault **we do not control**, and the page answers the question a sceptical
reader actually has:

> What exactly are we trusting, and what would break us if it changed?

The skill did something we had not asked for and would not have thought to do by
hand: it pulled Morpho's **verified Vault V2 source** into the workspace and read
it. That is where the page's sharpest line comes from, and it is a fact about the
venue that no amount of calling `totalAssets()` would surface:

> The owner can also replace the curator, and add or remove sentinels,
> **instantly: those three functions have no timelock in the verified VaultV2
> source.** A sentinel can only cancel a pending change, never make one.

It also honoured the one instruction that mattered. Asked to show the four
transfer gates, it refuses to summarise them unless it has read all four:

> Some gate reads failed (shown above). **The page will not call the gates open
> without reading all four.**

That is the right behaviour and we saw it fire for real — the first render hit
Arc's rate limiter and the page reported every gate as unread rather than
guessing. The same instinct runs through it: a fee it cannot read says so, and
the yield panel prints "no figure could be read" instead of annualising a number
from one observation.

**What we changed afterwards.** One thing, in `rd`, the single helper every
contract read passes through: a concurrency gate of three and a backoff that
retries only a rate-limited answer. The page asked Arc about thirty questions at
once, and on a loaded endpoint — which is exactly what a demo is, with the
keeper, the tape and the dashboard all talking to it — every panel came back
unreadable. A risk page that cannot read the risk is worse than no page, because
"could not read" and "closed" look the same to anyone skimming. The fix is in one
place rather than at the five call sites, so the two cannot drift apart.

## 4 · What Arc Studio did not do

Stated plainly, because a vague claim collapses under one question and a narrow
one does not:

- It did not write `FloatVault.sol`, `FloatPrintStore.sol`, the sleeves, or their
  80 tests.
- It did not write the keeper, the agents, the MCP server, the policy validator,
  or the acceptance harness.
- **It did not deploy the contracts, and an earlier draft of this file said it
  did.** The Arc Testnet deploy was `forge script DeployFloat.s.sol --broadcast`
  from our own deployer; `float/deployments/arc-testnet.json` names that address
  and the commit is `74ab486`. Studio's own CLI agrees — `arc-studio deployments
  --app b5aa43e1-…` answers **"No deployed contracts found."**

  It was offered the job and refused it on purpose: a Studio deploy signs with
  its shared platform wallet, that wallet would have become `owner`, and
  `wire()` is `onlyOwner` and one-shot. The treasury would have belonged to the
  sandbox. The overclaim is corrected here rather than quietly deleted, because
  a file arguing that narrow claims survive questioning should show what
  happened when one of its own did not.
- It did not author the dashboard — `index.html`, the panels, the tape. It wrote
  `walk.html` beside it (§3c), which is a different page and a narrower claim.
  It **holds** the dashboard — `index.html` was written in Claude Code and the
  copy in the Studio workspace is byte-identical. That is checkable rather than
  asserted:

  ```bash
  shasum -a 256 float/app/index.html
  arc-studio cat --app b5aa43e1-4d5c-4d47-b079-dcc9aea0e557 index.html | shasum -a 256
  ```

  **`index.html` agrees exactly. The two Studio pages do not, and should not** —
  they were hardened here after they arrived, so the workspace holds what Studio
  wrote and the repo holds what runs. Both columns are given, because a table
  with one number invites a judge to run the command, get the other, and
  conclude the evidence is fabricated. An earlier version of this section said
  "all three agree" while a paragraph below it said two had been edited locally;
  that contradiction is corrected here rather than quietly reworded.

  | file | in the Studio workspace | in this repo | written by |
  |---|---|---|---|
  | `index.html` | `7cc551eb…8615f640` · 17,420 | **identical** | Claude Code, then **Arc Studio** (§3f) |
  | `walk.html` | `ae8583da…1be2183d` · 27,787+ | `6efc9b0d…794f6bdd` · 27,787 | **Arc Studio** (§3c, §3f) |
  | `venue.html` | `48d9b548…e69273c3` · 59,600 | **identical** | **Arc Studio**, `morpho` skill (§3d, §3e) |

  The whole of the difference is the bare-403 retry: Arc answers a hard burst
  with an unbodied `403`, which neither page's original rate-limit predicate
  matched. `make studio-pull` reports it as *"1 file(s) skipped to protect local
  edits"*, which is the protection working.

  **`venue.html` and `index.html` agree as of 2026-11-06**, because each went
  back out to the workspace with `-f '<local>:<name>'` before its turn, so what
  Studio edited was the corrected file and what came back contains both halves.

  **`walk.html` now diverges for a different reason than it used to.** The 403
  fix is no longer the difference — that went out with the file. What differs is
  that this repo's copy has **28 lines of dead code removed**: Studio's §3f turn
  left the old `findJitTx()` orphaned rather than deleting it, and that function
  ends in a `throw` whose advice is *"Open this page with `?tx=0x…`"* — the very
  dead end §3f exists to remove, sitting unreachable in the file. Nothing calls
  it (`grep -cE '[^a-zA-Z]findJitTx\('` returns 1, its own declaration), so it
  changed no behaviour, but a throwing function carrying instructions a reader
  cannot follow is worth deleting rather than leaving for the next person to
  puzzle over.

## 3f · Making the pages drivable, with the `morpho` skill

All three pages had **zero event handlers between them** and took their only
configuration from a query string. Inside Arc Studio that is unreachable — the
preview panel has no address bar — so a reader got one fixed view.

Worse, `walk.html` had a dead end. It scans backwards for the newest
just-in-time payment in 6 windows of 9,000 blocks, about **7.7 hours** of Arc,
and on finding none it threw an error whose only remedy was a URL you could not
type there.

Studio was told the page already fetches **every** `Receipt` in that range and
discards all but one, so the control was a matter of not throwing away what it
already had. It added:

- a **payment picker** in `walk.html` — one row per receipt, newest first,
  carrying the id, the quote, whether it was funded just-in-time, the tx and the
  block. Clicking a row walks that payment. `?tx=` still works and the picker is
  shown beside it, so a reader can switch away from the transaction the URL named.
- a **`<select id="span">`** in `index.html`, four look-backs from 12,000 to
  108,000 blocks, each labelled with its per-request size — all at or under
  9,000, because Arc rejects `eth_getLogs` above a 10,000-block range.

**Verified by driving it over CDP**, which is the only way to know a control
works rather than exists:

| | |
|---|---|
| the picker | 2 rows, e.g. `#38 $1.05525 JIT 0xc956…3f45 block 71033422` |
| clicking the unselected row | walked **exactly** the tx that row names: expected `0xcd8a…4c04`, header became `0xcd8a…4c04`, and `aria-pressed` followed |
| `?tx=0x364723c6…` | walked that transaction and still offered the picker |
| the span selector | changing it re-rendered; every option ≤ 9,000 per request |

Worth recording honestly: **two of my own first attempts at that click test
reported a failure that was not there.** Both measured the page before it had
settled — the scan takes about 45 seconds under Arc's throttling — and one took
its "before" reading while the header was still unrendered, so it compared a
real tx against `?`. The page was right both times. A test that races the thing
it measures reports the tester's impatience as the product's defect.

## 3e · Asking the venue a question, with the `morpho` skill

The page read the venue's whole risk surface and could not be **driven**: zero
event handlers, and its only configuration came from a query string. That is
inert anywhere, and specifically broken inside Arc Studio, whose preview panel
has **no address bar** — so a reader there got one fixed view and no way to
explore.

Studio was given the compiled Eco Sauce program as read-only context and asked
to put its question in the browser: *could the venue deliver a shortfall right
now?* It added section 6 — a number input and a slider spanning zero to twice
the live position, text overrides for venue and sleeve, a re-read button, and
the program's four checks in the program's order, each with its own verdict.

**It was verified by driving it, not by reading the diff.** Over CDP, against
the live vault:

| | |
|---|---|
| the position it reports | `$6.261325` from `8935293198965717857` shares — **matched `cast` exactly**, both the share count and the converted value |
| at `$0.50` | *can cover* — all four checks pass |
| at `$50.00` | *refused*, in the program's own words: **"the sleeve cannot cover this shortfall. It needs $50.00; the position is worth $6.261325, which is $43.738675 short."** |
| one cent **below** the position | *can cover* |
| one cent **above** the position | *refused* |

So the threshold is exact to the cent, and the page and
`float/sauce/preflight.mjs` return the same verdict for the same amount — which
is the only test that matters, because a page that disagrees with the compiled
program is simply wrong.

Two things the page says that we did not ask it to, and both are right: it
distinguishes **a failed read from a refusal** ("a failed read is neither a
refusal nor a pass"), and it prints the timestamp of the reads it is reusing
plus the fact that moving the amount reuses a read under 10 seconds old rather
than silently re-querying Arc on every keystroke.

  **That edit shipped broken, and is worth recording because of how it got
  through.** The note explaining the 403 was inserted INSIDE the expression:

  ```js
  /rate limit|…|\b403\b/i // 403: a hard Arc burst … message.test(
  ```

  `//` runs to end of line, so it ate `.test(`. In `walk.html` that left a
  tagged template on a regex and an unmatched `)` — a **SyntaxError**, so the
  inline module never parsed and the page rendered its shell and ran nothing at
  all. In `venue.html` the same edit produced `(m) => /regex/i`, which returns a
  RegExp and is therefore **always truthy**, so every error was read as rate
  limiting. One page dead, one silently wrong, both committed and both on
  `origin/main`.

  Nothing in the repository could have caught it. These pages are single files
  with no build step — the property that lets a judge open one with no server —
  so `forge test`, `tsc`, the lint pass and the doc-claim audit all skip them,
  and the broken line reads as ordinary code in a diff. `float/src/pages.test.ts`
  now parses every page's module with `node --check` and separately asserts the
  predicate reaches `.test(`, since `venue.html`'s version was valid JavaScript
  that a parser cannot fault. Both assertions were confirmed against the broken
  files before being trusted.

  Files go out with `arc-studio run -f 'float/app/index.html:index.html'`, which
  **places** a file in the workspace instead of asking the model to retype it —
  the only way the claim above can be true. Studio was told not to reformat or
  "improve" them, and did not.

  **Files come back with `pull`, never with `cat`.** `make studio-pull` runs
  `arc-studio pull --dry-run --diff` first, and `studio-pull-apply` takes it.
  This is not a style preference. `cat > file` is a dumb read: no record of what
  came from where, no diff, and no protection. `pull` tracks what it downloaded
  and skips anything edited locally since:

  ```
  1 file(s) skipped to protect local edits — re-run with --force to overwrite
  ```

  That is not hypothetical here — both Studio-authored pages were edited locally
  after they arrived (§3d), and a second `cat` would have destroyed those edits
  without saying so. `cat` keeps one job: reading a file to hash or inspect it
  without writing anything, which is what the commands above do. `--force` is
  never the answer; its only effect is to defeat the protection.

    **"Byte-identical" is a claim about the file, not about what the preview
  renders**, and the distinction is Arc Studio's own correction rather than ours.
  Asked to confirm the preview served these bytes, it declined and said why: the
  preview is a Vite dev server, which injects a `/@vite/client` module and a
  React-refresh block into the head of every HTML page it serves and lifts the
  inline module script out into a separate proxied module. So a byte comparison
  against what the preview returns fails at line 4, for both pages, while the
  script contents are untouched and the page behaves identically. `arc-studio
  cat` reads the file on disk, which is what the hashes above measure. An earlier
  draft of this section said Studio "serves it byte-for-byte"; that was wrong
  about the preview, and it is corrected here rather than quietly reworded.
- It did not touch the World ID gate, which belongs to a separate workstream and
  was written outside Studio.

See `hackathon/ethglobal-mumbai-2026/CONTINUITY.md` for the full attribution,
including which parts of this repository were authored with AI assistance, as
ETHGlobal's rules require.
