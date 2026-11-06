# ETHGlobal Mumbai — submission copy (World ID Agent Pass)

Bounty: **World — World ID Agent Pass, Continuity Track.**

Stated explicitly, as the Arc entry does, because a submission that names its
bounty is easier to judge. World is **one** partner-prize slot and covers both
World tracks; the IDKit entry is
[`SUBMISSION-WORLD-IDKIT.md`](./SUBMISSION-WORLD-IDKIT.md).

---

## The one-liner

> The agent's wallet holds $0 and its budget lives in a vault. When it asks to
> overpay, the payment is not refused — it is **parked on chain until a verified
> human clears it**, and the refusal paths leave as much public evidence as the
> approval does.

## What it is

An agent with a spending limit has a worst case equal to the limit. Neither a
balance nor a limit answers the question an overcharge actually fails: *is this
a fair price?* Float holds the budget in a vault that recomputes the fair total
itself from ACR's on-chain compute price and refuses anything above a band.

**Agent Pass is what happens at the edge of that band.** Over the per-request
threshold the request is not denied. A checkpoint opens on chain; a human
completes a *fresh* World ID device-flow authentication; the backend validates
that ID token against a fixed ladder; and only then does a single-use EIP-712
approval let the vault move USDC.

Three properties are the whole design:

1. **An approval widens the band. It never removes it.** A person can authorise
   paying more than usual. Nobody — including the approver — can authorise
   paying an unpriced amount to an unapproved seller. `executeApproved`
   re-checks band, cap and print *after* the signature is accepted, so a valid
   human and a refused payment is a real and tested state.
2. **The approver cannot invent a spend.** The approval commits to
   `FloatApproval(uint256 id, bytes32 reqHash, uint64 expiresAt, bytes32
   humanBinding)`. The vault compares the request against the hash it opened the
   checkpoint with, within its TTL, once. Replay, re-aim at another seller, a
   different amount, a fabricated checkpoint id and a signature from the wrong
   key are each refused on chain, each with its own test.
3. **A refusal is evidence, not silence.** Denial, expiry and a failed
   verification are each written on chain as `CheckpointResolved`. A treasury
   whose refusals are invisible cannot be audited.

## Why it is a Continuity project

ACR used World ID before this event, and the line is drawn in
[`CONTINUITY.md` §4.2](./CONTINUITY.md) with every file named.

> **Before:** a unique-human proof gated a *read*. It unlocked the aggregate
> spend view across one person's wallet fleet, and an on-chain mirror recorded a
> window-rotated cluster id so the uniqueness was auditable without ever storing
> a nullifier.
>
> **Now:** the same identity **releases money.**

The prior work is not a claim either: feedback written from that integration is
in [`hackathon/ethonline-2026/FEEDBACK_WORLD.md`](../ethonline-2026/FEEDBACK_WORLD.md),
whose own numbers were observed on World Chain mainnet on 2026-09-09, and the
design doc beside it in `WORLD-MODULE.md`. This round's feedback is
[`docs/WORLD_DEBRIEF.md`](../../docs/WORLD_DEBRIEF.md), which continues it
rather than starting over.

## Secure backend validation

The ID token is validated server-side against **nine named refusals, reported
in a fixed order, naming the first rung that failed rather than the last.**

```
malformed_token · bad_signature · wrong_issuer · wrong_audience · expired
assurance_not_accepted · amr_not_accepted · auth_time_outside_window
not_the_enrolled_treasurer
```

The count is pinned by a test rather than by this sentence:
`worldauth.REASONS` is the tuple and `test_every_named_reason_is_reachable`
asserts set-equality between it and the reasons nine fixtures actually produce,
so the prose cannot drift from the code without a red test.

Four decisions in there are worth defending out loud:

- **The algorithm is pinned, not read from the token.** `alg: none` and
  HS256-signed-with-the-public-key are both refused as `bad_signature` — the two
  classic JWT forgeries, each with its own fixture.
- **Freshness is measured against when the checkpoint opened**, not against
  "now". A token minted before the payment existed cannot approve it.
- **Reporting the first failing rung is deliberate.** A stale `auth_time`, an
  unverified account and the wrong person are three problems with three fixes,
  and collapsing them into "verification failed" is what makes an approval gate
  undebuggable.
- **503 is never an approval, and a 429 ends the attempt.** `slow_down` widens
  every later interval, not just the next. The status check happens *before* the
  body is parsed, so an unparseable error page cannot be mistaken for a verdict.

A device code never appears in any serialisation of a checkpoint: it is held in
a separate map keyed by checkpoint id, which is a structural guarantee rather
than a rule someone has to remember.

## The full journey, and every unsuccessful path

One command walks all of it and prints the value at each step rather than a
tick, because a step that "passed" while showing nothing a viewer could read is
not a demonstration:

```bash
anvil --port 8546
cd contracts && forge build
make rehearse-float
```

Ten legs, from a real run:

| leg | what the chain and the screen show |
|---|---|
| roles | approver, registrar and executor read **back off the vault**; approver ≠ executor, so one hot key cannot open a checkpoint and sign its own approval |
| the agent's wallet | `0.000000 USDC` before anything and after everything |
| in policy | a 0.90 USDC quote pays straight through, no human asked |
| out of policy | `quote exceeds ACR fair band` — 18.540000 USDC against a fair 18.000000 USDC, a **3.00% premium**, checkpoint open on chain with its agentId, reqHash and expiry |
| **approve** | token accepted at `acr=orb`; the local digest cross-checked against the vault's own `approvalDigest`; seller 0.900000 → 19.440000 USDC; checkpoint **CONSUMED** so the approval cannot be replayed |
| **DENIED** | `CheckpointResolved(denied)`, **seller unchanged**, reason recorded |
| **EXPIRED** | the chain clock moved past the 300 s window; `CheckpointResolved(expired)`, seller unchanged |
| **WRONG HUMAN** | a correctly signed, in-date, right-class token from a different subject → `not_the_enrolled_treasurer`. Also shown: an unaccepted assurance class, and a token minted before the checkpoint opened |
| **AGENT MISMATCH** | a checkpoint opened for `scout` cannot release a payment for `waster`; the transaction rolls back and the checkpoint is **still OPEN** for the agent it was parked for |
| guest budgets | one 2.000000 USDC budget per unique human; the same human asking twice is refused by the chain itself |

`REHEARSE_WORLD=live` swaps the token's provenance for the real device flow and
leaves every other line alone, so the rehearsal and the recording are the same
script.

## What is demonstrably true

Every claim is re-derivable by a command in the repo.

| claim | how to check |
|---|---|
| 174 tests across the World and gate suites | `uv run pytest services/index_api/tests/test_{worldauth,worldflow,floatgate,floatgate_onchain,floatguest,float_api}.py` |
| Nine named refusals, and the prose cannot drift from them | `test_every_named_reason_is_reachable` |
| `alg: none` and HS256-with-the-public-key are both refused | `test_an_unsigned_token_is_refused`, `test_a_token_signed_with_the_public_key_as_an_hmac_secret_is_refused` |
| The signer refuses to broadcast a digest the vault disagrees with | `sign_approval` cross-checks `approvalDigest` and recovers the signature to our own key before sending |
| Replay, re-aim, expiry and a fabricated id are refused **on chain** | `uv run pytest services/index_api/tests/test_floatgate_onchain.py` (20 tests, against a real vault on a local chain) |
| A checkpoint opened for one agent cannot pay another | `test_a_real_checkpoint_executed_for_another_agent_is_refused` |
| The whole journey, with its three unsuccessful paths | `make rehearse-float` |
| The vault is deployed on a public chain | `eth_getCode` at `0xb030e7e592eb2d8a989c7cbca01270b957bb4bdc` on `https://rpc.testnet.arc.io` returns 19,486 bytes (chain 5042002) |
| Nothing was a single end-of-event upload | `git log --oneline` — the World work is ten commits, each with its witness run |

## Honest limits

- **`access_denied` means three different things** and the provider cannot tell
  us which: the human refused, the essential assurance class was unmet, or the
  subject did not match. We record it as DENIED with a reason naming all three.
  We never report it as "the human denied it", because two thirds of the time
  that would be a guess. This is also our top debrief item's sibling.
- **The approval screen cannot say what is being approved.** World's device
  profile is explicit that `binding_message` and action terms are unsupported
  and are not displayed or signed into the token, so the signed token attests
  *who* authenticated and *when*, never *what* they agreed to. We therefore
  render the amount, seller, fair price and user code ourselves and bind them
  server-side. This is the single improvement we would most like, and it is
  argued in the debrief from World's own documentation rather than from opinion.
- **The executor can resolve any open checkpoint, including writing EXPIRED over
  one a human already signed.** This is finding **F8** in our own Arc Studio
  audit (`float/studio/README.md`), accepted and not repaired. It qualifies the
  containment claim honestly: the approver cannot invent a spend, but the
  executor can nullify an approval. Narrowing `resolveCheckpoint` to the
  checkpoint's own opener is the fix and it is not in this submission.
- **Neither issuer advertises a Selfie assurance class.** `acr_values_supported`
  is exactly `orb` and `orb-face` on both `auth.world.org` and
  `sandbox.auth.world.org`, measured. The step-up guide documents a `selfie`
  class that neither issuer offers, so we request `orb` alone: naming an
  unadvertised class in an *essential* claim is not a preference a provider
  ignores, it is a requirement it cannot meet. The gate cross-checks its
  configured classes against discovery and stands down rather than sending a
  request that cannot succeed.
- **A policy change is held to its own assurance list, but our shipped default
  is not a stronger one.** `requirePolicyCheckpoint` really does gate
  `setPolicy`, `setAgent` and `allowSeller` over a hash the chain derives
  itself, and `make rehearse-float` leg 11 shows an unapproved change refused,
  a face verification accepted and the band moving from 10% to 12% only once a
  person signed. But the default list is `orb-face, orb`, which accepts a plain
  orb token: it is a superset of the payment list, so what the default actually
  gives is a second, independent, *fresh* verification rather than a higher
  class. Narrowing it to `orb-face` alone makes the separation real, and the
  rehearsal demonstrates that configuration. We ship the wider default because
  a treasurer with no face credential would otherwise be locked out of their
  own policy permanently, which is a worse failure than a weaker gate.
- **The guest daily cap is fixed at deploy** (`guestDailyCap`, constructor-only).
  Changing it is a redeploy. We state it because "revocable budget" could
  otherwise be read as "adjustable budget".
- **The identity of the human the chain holds approvals to** is
  `treasurerBinding = keccak256("acr.treasurer::" ‖ iss ‖ 0x1f ‖ sub)`, set
  one-shot from zero. On the public deployment it is **still zero**, which means
  the chain does not yet pin a particular person and the server-side ladder is
  what enforces identity. Setting it requires the enrollment run, and a *wrong*
  value is worse than none — the approval would stay valid and bind to the wrong
  person — so it is set last, after a dry run proves the digest round-trips.

## Status of the live run, stated plainly

The engine is complete and adversarially tested; what it has not yet had is a
token from World's production issuer, because the Agent Pass client registration
is an operator action that had not happened when this was written. Concretely:

- Everything above marked with a command **runs today**, with a token this
  repo mints itself: a genuine RS256 ID token from a locally generated key, run
  through the same nine-rung ladder a live token goes through. **What is
  synthetic is the issuer, not the validation.**
- What a live client adds is the device flow's own leg — a user code on a phone,
  a real `sub`, a real `auth_time` — and the three timing rows still marked
  *pending the live run* in the debrief. `make world-probe` produces them in
  about twenty seconds once the client exists, and it was written before the
  credentials did so the figure would be a measurement rather than a memory.
- The path up to "needs a real client" **was** verified against the live API
  without one: discovery answers on both issuers, `claims_parameter_supported`
  is true on both, and the device authorization endpoint correctly refuses an
  unregistered client with HTTP 401.

We would rather say this than show a demo whose provenance is ambiguous.

---

## Links to fill in at submission time

- **GitHub**: https://github.com/kaustubh76/ACR---Arc-Compute-Rate
- **Debrief (required by both World bounties)**: [`docs/WORLD_DEBRIEF.md`](../../docs/WORLD_DEBRIEF.md)
- **Continuity disclosure**: [`CONTINUITY.md` §4.2](./CONTINUITY.md)
- **FloatVault on Arc Testnet**: `0xb030e7e592eb2d8a989c7cbca01270b957bb4bdc` (chain 5042002)
- **The approvals card**: `/float/approve` on the terminal
- **Video**: _pending_ — the deny clip is mandatory and is leg 6 above
