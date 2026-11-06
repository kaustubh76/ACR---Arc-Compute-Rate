# ETHGlobal Mumbai — submission copy (Best Use of IDKit)

Bounty: **World — Best Use of IDKit.**

World is **one** partner-prize slot and covers both World tracks; the Agent Pass
entry is [`SUBMISSION-WORLD-AGENT-PASS.md`](./SUBMISSION-WORLD-AGENT-PASS.md).

---

## The one-liner

> Prove you are a person once, and an AI agent gets a wallet with a real budget
> it did not have to be trusted with — **2 USDC a day, revocable, and one per
> human, enforced by the chain rather than by our database.**

## What it is

Float is an onchain treasury where an agent's own wallet holds $0 and a vault
checks every spend against policy and a live compute price. Named agents are
configured by a treasurer. **Guests are not.**

A guest join is the public door: a visitor completes a World ID uniqueness check
and the vault registers a guest agent with a fixed small daily cap. The whole
problem is farming — one person minting a hundred agents and a hundred budgets —
and the whole answer is that uniqueness is checked in three independent places,
none of which is a row in our own database that we could be talked out of.

## The credential choice, which is priced rather than asserted

The bounty asks why this is the minimum sufficient assurance. Verbatim, the
decision as it was written down:

> **Small revocable budget → least identity that stops farming: Selfie Check +
> sybil floor; Orb is the config flag for real money; passport rejected — more
> identity than the risk needs.**

And the reason it is defensible is that both sides of it carry a number ACR
already audits for its own index. `anchors/_basket/C-HUMAN.json` prices *the cost
to an attacker of controlling one verified human identity they do not own*, and
`acr_estimator.human_caps.load_cost_per_human()` returns `(10.0, 'unsourced',
True)` — ten dollars, flagged a **lower bound**, cross-checked against the basket
file by `scripts/anchors.py`.

So the argument is an inequality with a real figure on both sides:

**A guest budget of 2 USDC a day is 20% of that floor, so a rented identity does
not pay for itself inside five days.**

The basket's own `rule.note` says the floor *"sits well below any plausible real
rate so the derived bound understates rather than overstates"*, which widens that
margin rather than narrowing it. We cite it as a lower bound with its
`status: "unsourced"` intact, because quoting it as measured would be the one
dishonest sentence in this submission. We deliberately do **not** cite the
basket's excluded `$0.00` row for Orb verification: that is the cost to the
person verifying, and therefore not the attacker's cost.

Selfie Check also needs **no Orb**, which is the point. An assurance that the
average visitor cannot obtain protects nothing, because nobody passes it.

## Three independent layers of uniqueness

1. **World's own property.** A uniqueness proof is one-time per action, and the
   action string is fixed (`acr-float-guest-budget-v1`). A proof minted for
   another action authorises nothing here.
2. **Our ledger**, keyed on the **nullifier** — not on the rotating cluster id
   the earlier read-gating integration used, because a 7-day window is not a
   once-per-human key. The claim line is written *before* the chain call so a
   crash cannot be farmed, and released if the write fails.
3. **The chain, which is the authority.** The guest agent id is
   `keccak256("acr.guest::" ‖ nullifier)`, so from a nullifier the chain answers
   *for that human* in a single `eth_call`, and `registerGuest` itself reverts
   `agent exists`. That revert is treated as **success** (HTTP 409, "one guest
   budget per human"), because it means the human already has a budget — and it
   is what makes a crash mid-flow safe.

Layer 3 is why this needed no scheduled reconciliation sweep. The repo's
existing faucet ledger re-reads a provider's whole transaction list every ten
minutes because that provider cannot cheaply answer "was this one address
paid?". Our authority can, per claim, which removes the TTL, the staleness
window and the enumeration together — and makes a host with no persistent disk
a non-problem rather than something to compensate for.

**The nullifier never reaches the chain, a response, or a log.** What goes on
chain is its hash; what goes in the log is `mask()`ed to `••••` plus three
characters; what comes back to the browser is the same mask. The earlier
integration deliberately dropped the nullifier when a request ended, so this is
the first place in the repo that must retain one, and that is stated rather than
quietly done.

## The server verification

`POST {base}/api/v4/verify/{rp_id}` with `protocol_version: "4.0"`, forwarding
the IDKit result **as-is** with only `environment` overridden. World's docs are
explicit that the result needs no field remapping, and renaming a field would be
re-deriving a contract we do not own against a service that will simply reject
it. On `app_not_migrated` it retries the v2 endpoint and records that it did.

`environment` is **observed, not asserted**: if the payload claims an
environment that differs from ours, it is refused *before* the network call, and
what the verifier reports back is recorded rather than assumed.

Eight named refusals, so the join page can say which thing went wrong instead of
"verification failed":

```
wrong_environment · unknown_or_expired_request · verify_failed · no_nullifier
below_sybil_floor · one_guest_budget_per_human · not_a_guest_agent
the_till_is_empty
```

Two of those are worth explaining:

- **`the_till_is_empty`** — there is deliberately **no global cap counter**. A
  counter that resets when the process restarts reads as protection while
  providing none, and the cardinality it would need is not recoverable from the
  chain. Instead the vault's own free float is checked against one guest budget,
  so the refusal is a fact about the treasury rather than a number we kept.
- **`not_a_guest_agent`** — a 500, not a 409, because an agent id colliding with
  a *named* agent is our bug and should read like one.

The nonce binding exists because `selfieCheck` carries no signal of its own, so
the signed nonce is the only thing tying a human's proof to one particular
wallet. It is spent **either way**: presenting an expired nonce both fails and
consumes it, because a nonce that can be retried is not single-use.

## Alternates, all of them demonstrable

| path | what happens |
|---|---|
| **success** | a guest agent appears on chain with a 2.000000 USDC daily cap, flagged `guest` so it is revocable without touching a named agent |
| **same human, second agent** | refused — by the chain itself, as `agent exists`. **This is the repeatable beat: it needs no new human to demonstrate** |
| **cancelled in World App** | no proof arrives, the nonce expires unspent, no budget |
| **no World App installed** | the join page offers the install path rather than a dead widget |
| **below the sybil floor** | refused, and the floor is a configured number rather than a hardcoded one |
| **wrong environment** | refused before any network call |
| **nonce reused or expired** | refused, and the nonce is consumed in both cases |

## What is demonstrably true

| claim | how to check |
|---|---|
| 31 tests over the guest server, including the full rejection matrix | `uv run pytest services/index_api/tests/test_floatguest.py` |
| The nullifier reaches neither a response nor a log | a test asserts it against both |
| One budget per human, enforced on chain | `make rehearse-float` leg 10 — issues one, then the same human is refused and the budget is not widened |
| The guest cap is 2 USDC and fixed at deploy | `guestDailyCap()` on the vault returns `2000000` |
| The $10 attacker-cost floor is the repo's own audited number, flagged unsourced | `load_cost_per_human()` returns `(10.0, 'unsourced', True)` |
| The vault is deployed on a public chain | `eth_getCode` at `0xb030e7e592eb2d8a989c7cbca01270b957bb4bdc` on `https://rpc.testnet.arc.io` (chain 5042002) |

## Honest limits

- **The browser widget is the newest part of this**, and the server half is
  older and better tested than the page in front of it. The repo recorded why
  for months: *"IDKit v4 needs an `rp_context` and a preset only the Developer
  Portal can supply, and shipping a widget built against guessed config would be
  a button that can only fail."* That comment is in
  `apps/terminal/app/api/humanid/tca/route.ts` and this submission is the thing
  that reverses it.
- **Selfie Check carries a `sybil_score` and we apply a floor to it, but we did
  not calibrate that floor against measured abuse** — we have no abuse data. It
  is set conservatively and named as a configured number, not a finding.
- **A guest budget is small on purpose and that is the security argument, not a
  product limitation.** The cap is fixed at deploy, so "revocable" should not be
  read as "adjustable".
- **One human can still hold one guest budget and one named agent.** The three
  uniqueness layers stop *farming*, not *a person who is also a customer*.
- **Orb remains a config flag, not a shipped tier.** We assert that raising the
  assurance for real money is a one-line change, and that claim is a
  configuration path we have exercised in tests, not a deployment we have run.

## Status, stated plainly

The server half — verification, the nonce binding, the ledger, the chain as
authority, the eight refusals — is complete, tested and exercised end to end by
`make rehearse-float`. The browser join page is built and the production build
carries it; what it still needs is configuration, and the widget's own types
say that is **three** values from the Developer Portal rather than two:
`app_id` (typed `app_${string}`), `rp_id` (inside the signed `rp_context`), and
the signing key. Supplying it is an operator action.

Two are in hand and recorded in `.env.example`, because both are public — the
`app_id` ships to the browser inside the widget, and the public key id only
identifies which key pair is ours. Outstanding are the **private** signing key
and the `rp_id`, which is a third distinct value rather than a restatement of
either: `rp_` followed by hex that must fit a **uint64**, read off
`@worldcoin/idkit-core@4.6.0`'s own normalizer rather than its README, so the
64-hex public key id cannot be it.

**One thing a judge will notice and should not have to guess at.** This IDKit app
is a **production** app, while our Agent Pass client is on World's **sandbox**
issuer. They are separate systems with separate credentials and the split is
deliberate: Selfie Check needs no Orb, so the IDKit path is reachable on
production, whereas the Agent Pass portal does not open to a non-Orb developer
account. `ACR_FLOAT_GUEST_ENVIRONMENT` therefore stays `production`, and it is
**observed on the way back** rather than asserted, so a proof minted against a
different environment is refused before any network call.

Our own
rule for this event is that **a track whose module is half-built is not
entered**, because a half-entry burns judge goodwill the other entries need. So
this submission stands or falls on the join flow actually working, and we would
rather withdraw it than show a widget that cannot complete.

---

## Links to fill in at submission time

- **GitHub**: https://github.com/kaustubh76/ACR---Arc-Compute-Rate
- **Debrief (required by both World bounties)**: [`docs/WORLD_DEBRIEF.md`](../../docs/WORLD_DEBRIEF.md)
- **Continuity disclosure**: [`CONTINUITY.md`](./CONTINUITY.md)
- **The join page**: `/float/join` on the terminal
- **Video**: _pending_ — must include the duplicate-human refusal
