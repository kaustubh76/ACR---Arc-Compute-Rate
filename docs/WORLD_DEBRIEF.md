# World ID integration debrief — ACR Float

Feedback for the World ID bounties at ETHGlobal Mumbai, November 2026. We
entered **Agent Pass** and its live run completed; we built for **Best Use of
IDKit** and withdrew it, because the Selfie Check it rests on is no longer
offered (§3). Both halves of that are reported here, since the half that did not
ship produced the more useful feedback. It continues
[`hackathon/ethonline-2026/FEEDBACK_WORLD.md`](../hackathon/ethonline-2026/FEEDBACK_WORLD.md),
written at ETHOnline when ACR used World ID to gate a *read*. This round the
same identity releases *money*, so the friction is different and sharper.

**What we built.** An AI agent's out-of-policy payment is parked on chain. A
verified human completes a **fresh** World ID device-flow authentication, our
backend validates that token against a fixed ladder of nine named refusals, and
only then does a single-use EIP-712 approval let the vault move USDC. Denial,
expiry and a failed verification are each recorded on chain as public evidence.
Separately, a venue visitor completes a **Selfie Check** and their agent gets a
2 USDC/day budget — one per unique human.

---

## 1 · Time to first success

| measurement | value | what can fill it |
|---|---|---|
| Discovery read and validated against the configured issuer | **1.6 s** (median of 5; 1.2–7.8 s) | `make world-probe` |
| A device authorization → a validated token, twice | **84.0 s** and **49.4 s** | `make world-probe` |
| First Selfie Check → verified nullifier | **not measurable: the check was withdrawn** | nothing; see §3 |

**Measured live on 2026-11-06 against `sandbox.auth.world.org`**, with a
registered client and a real person holding a phone. Both figures are
end-to-end and **the human dominates the second one**: the protocol floors the
poll interval at five seconds, so of those 84.0 s and 49.4 s our own share is
the sub-second validation at the end. Reporting a single blended number would
have hidden that, which is why the two runs are both here rather than averaged.
The spread between them is a person reaching for a phone, twice.

`make world-probe` fills the **first two** rows: it prints the achieved `acr`,
`amr`, `auth_time` and the elapsed seconds. It cannot fill the third, and the
third column exists because an earlier version of this table implied it could.
Agent Pass and IDKit are separate systems with separate credentials, and the
device-flow probe never touches a Selfie Check. Nothing we can run produces that
row: the proof and the nullifier are World's to issue, so the only thing that
fills it is a person with World App and an `rp_id` registered to our key.

All three were written before the credentials existed, so each figure would be a
measurement rather than a memory.

What we **can** report now, because it was measured against the live API without
any credential: discovery on both `auth.world.org` and
`sandbox.auth.world.org` answers in one request, `claims_parameter_supported` is
true on both, and the device authorization endpoint correctly refuses an
unregistered client with HTTP 401. The whole path up to "needs a real client"
was verifiable before we had one, which is a good property and worth keeping.

And what we can report about our own half, separately, because conflating the
two would make the table useless. `make rehearse-float` walks the entire
journey against a real vault on a local chain and times each leg:

| leg, measured | elapsed |
|---|---|
| stand up a vault, wire three roles, seed a policy and fund it | 1.6 s |
| park a payment, validate a human, release it to the seller | 0.5 s |
| park and record a denial on chain | 0.4 s |
| park and let the window close, recorded as expiry | 0.4 s |
| three refusals that are not the human's fault | under 0.1 s |
| a visitor joins and is issued a guest budget | 0.3 s |
| change the rules, held to a stronger class than the payment was | 0.5 s |
| the whole device flow against a **local** issuer, token fetched over HTTP | 5.9 s |

One run, on a local chain. The per-leg figures move by a few hundred
milliseconds between runs, so they are worth reading as orders of magnitude
rather than constants, and that is the whole point of them: nothing on our side
is close to the seconds a person spends reaching for a phone. The guest row is
our half only, because the proof it carries comes from a local stand-in.

**The last row is the one that needs its boundary stated.** `REHEARSE_WORLD=fake`
stands up an OIDC issuer on an ephemeral local port and runs the real device
flow against it: discovery and its issuer check, the essential-`acr` claims
parameter, the device grant, the poll table including an
`authorization_pending`, a JWKS fetched over the wire, the nine rungs, and a
payment released on chain by a token nothing local minted. **5.0 of those 5.9
seconds are the protocol's own five-second minimum poll interval**, which is the
useful part of the measurement: our share of it is under a second, and the floor
is the spec's.

It is there because the default rehearsal never reached `worldflow.py` at all --
it injects a validator -- so the most protocol-heavy file in this integration
had no end-to-end witness. It now has one. **It is not evidence about World.** A
local issuer answers yes because it was written to; what is proven is the code
between our configuration and a token, not that the token means a person. The
three rows above stay pending for exactly that reason.

Those numbers are the *mechanism*, not the provider: the token in that run is
one we mint ourselves and validate through the same nine-rung ladder, so what
they measure is how long our side takes once a human has answered. The three
rows above still waiting are the ones only World's own issuer can fill, and the
separation is deliberate — a single blended figure would hide which side of the
boundary any latency came from.

## 2 · Friction encountered

**The approval screen cannot say what is being approved.** This is the one that
shaped our architecture — see §4.

**`access_denied` carries three different meanings.** The docs are clear that
denial ends the attempt, but not that the same code arrives when an essential
`acr` cannot be met and when `claims.id_token.sub` mismatches. A backend
therefore cannot tell "the human said no" from "that account is not verified
enough" from "that was the wrong person". We record the outcome as a denial,
because nothing moved and no token was issued, but our reason string has to name
all three possibilities — and an operator reading a dashboard that said "the
human denied it" would go and debug the wrong thing.

**Discovery omits a class the step-up guide documents.** `acr_values_supported`
is exactly `orb` and `orb-face` on **both** production and sandbox. The step-up
guide also describes `selfie` and `selfie-face` as requestable classes. A
developer who follows the guide configures a class no issuer advertises, and
because an *essential* claim it cannot meet is refused as `access_denied`, the
failure reads as the human declining. We now cross-check the configured classes
against discovery and refuse to park a payment rather than send a request that
cannot succeed — but the first hour went into working out which of the two
sources to believe.

**The sandbox has a human in the loop.** For a developer without an Orb, the
documented path to an Orb-class token is a sandbox World ID, which needs a
TestFlight build from a World contact plus about an hour for issuance. Inside a
34-hour hackathon that is the difference between entering a bounty and not. The
bounty page says *"We are mocking proofs now, so you don't need sandbox app
anymore"*, which would remove the problem entirely — but that sentence appears
nowhere in the documentation, so we could not plan around it and had to treat it
as a bonus rather than a path.

**`acr` and `amr` can disagree about freshness, and only `amr` tells you.** The
live token came back with `acr` = orb and `amr` = `["pop","user","mfa"]` — the
passkey shape, which the docs themselves note *"does not assert a fresh World
proof"*. So a token can carry orb-level assurance while the authentication that
produced it was a passkey unlock rather than a fresh orb scan. For a read that
is fine. For releasing money it is the whole question, and a relying party that
gates on `acr` alone cannot see the difference. We require `face` in `amr` and
forbid `mfa` on the policy path for exactly this reason, and this was the first
live token to exercise it: the same token that legitimately cleared a payment
would be refused for a rule change. **The guidance we wanted and did not find
is a single sentence saying `acr` answers "how strong" and `amr` answers "how
fresh", because the device profile puts them a page apart.**

**IDKit's three representations of one nullifier.** v4 returns 0x-prefixed hex,
v2 returns `nullifier_hash`, and the integration guide recommends storing a
decimal `NUMERIC(78, 0)`. One value, three shapes, across two generations that a
single app may serve during migration. We normalise on the way in, and a
normalisation helper in the SDK would prevent a whole class of bug where the
same human is counted as two people.

## 3 · Missing capability or documentation

- **No device-flow example of the `claims` parameter.** The step-up guide gives
  the essential-`acr` JSON and notes that the device endpoint accepts the same
  parameter, but there is no device example showing the encoding. We send it as
  URL-encoded JSON in the form body; a one-line example would have removed a
  guess from the one request that everything else depends on. Worth stressing
  that the `values` **array** is the enforceable form — the singular `value`
  spelling is a different member of the OIDC claims syntax and asking with it
  requests nothing.
- **We built on Selfie Check, and it is no longer offered.** Confirmed with the
  World team on 2026-11-06, after the credential choice had been designed,
  implemented, tested and written up around it. The documentation we worked from
  still describes it — `issuer_schema_id: 11`, the `sybil_score`, the
  `integrity_bundle` — so there was nothing in the docs to warn us off. **The
  ask is a deprecation marker in the reference itself, not only in a
  conversation**: one line saying a schema is withdrawn would have redirected a
  day of work, and a developer reading the integration guide today would make
  the same choice we did.
- **And while it existed, where to read a trustworthy `sybil_score` was never
  stated.** The score is required in the verify *request* and the
  `integrity_bundle` is documented as covering it, but the score does not appear
  in the documented verify *response* schema — so the value a backend gates on is
  one the client supplied and the server forwarded. We believe the integrity
  bundle is what made that sound. The docs never said so, and for a field whose
  whole purpose is anti-farming that sentence was worth writing down. We record
  it even though the feature is gone, because the same gap will exist in
  whatever replaces it.
- **No `amr` reference beside the device profile.** The three documented shapes
  (`["pop"]`, `["pop","face","user"]`, `["pop","user","mfa"]`) and the note that
  only the passkey factor asserts MFA and *"does not assert a fresh World
  proof"* are exactly what an approval gate needs, and they live a page away
  from the flow that needs them.
- **Mixed protocol versions in one reference.** The verify page's request
  example uses `protocol_version: "3.0"` with a legacy body while the
  integration guide shows 4.0 payloads.

## 4 · The one improvement with the greatest impact

**Let the relying party put the transaction in front of the human.**

The device profile is explicit: *"binding_message or action terms — Unsupported.
They are not displayed on the approval page or signed into the ID token. The
human sees the requester and user code."*

For authentication that is fine. For **approval** it means the person is told who
is asking and nothing about what they are agreeing to. So we render the amount,
the counterparty and the fair price on our own screen, beside the user code, and
bind them to the attempt server-side — which is what the step-up guide itself
prescribes: *"Save the exact action, version, destination, owning account, and
expiry, bound to the authentication attempt… show the saved action to the user
and record their approval or denial."*

That works, and we are not arguing it is wrong. But it means the signed artifact
attests **who authenticated and when**, never **what they agreed to**, so the
integrity of the amount rests entirely on our own UI and our own binding. A
human who approves on a phone across the room from our screen has approved a
code, not a payment.

The ask, in order of how much each would help:

1. **An optional `binding_message`, displayed and hashed into the ID token.**
   Even 60 characters would let "Pay 18.00 USDC to TestSeller" be the thing the
   human sees *and* the thing the signature covers.
2. **A signed action-approval receipt**, as the docs hint at when they say *"If
   your policy requires a signed action-approval receipt, keep the operation
   blocked until you validate one through a profile that advertises support for
   it."* We would use that profile today if it existed; we could not find one.
3. **Distinct error codes for the three `access_denied` cases**, or an
   `error_description` that separates them. This is the cheapest of the three
   and it would improve every integration, not just ours.

---

## Appendix · what we validated, and how

Every claim above is checkable. The validation ladder and the device-flow poll
table are tested offline against locally signed fixtures — which the testing
guide recommends: *"Use local signed fixtures to exercise validation failures
and application policy without requiring a person for every test."*

| what | where |
|---|---|
| The nine-rung ladder, one fixture per rung, first failure reported | `services/index_api/tests/test_worldauth.py` |
| `alg` pinned: `alg:none` and HS256-signed-with-the-RSA-public-key both refused | same file |
| `auth_time` must be after the checkpoint opened, not merely recent | same file |
| The poll table: 503 never an approval, 429 ends the attempt, `slow_down` widens every later interval | `services/index_api/tests/test_worldflow.py` |
| The device code never reaches a public view, a log or a response | `services/index_api/tests/test_floatgate.py` |
| Approve, deny, expire, forged token, wrong human — on chain, nothing moved | `services/index_api/tests/test_floatgate_onchain.py` |
| An approver key the vault will not accept is refused **before** a human is asked | same file |
| A zero `treasurerBinding` still clears a payment, so the binding is not the guarantee | same file |
| The guest path's eight named refusals, the v4→v2 fallback, and a nullifier that reaches neither a log nor a response | `services/index_api/tests/test_floatguest.py` |
| The SDK→wire rename the widget depends on, pinned at both ends | `apps/terminal/lib/rpContext.test.ts` |
| A visitor joins, is issued a budget, and is then refused by all three uniqueness layers | `make rehearse-float` leg 10 |
| The device flow over a real socket: discovery, the claims parameter, the poll table, a JWKS fetch, and the nine rungs on a token we did not mint | `tests/test_fake_agent_pass.py` |
| An unadvertised essential `acr` and a human refusing produce the **same** code, asserted as one string | same file |
| A mismatched JWKS and a non-enrolled subject each refuse by name | same file |
