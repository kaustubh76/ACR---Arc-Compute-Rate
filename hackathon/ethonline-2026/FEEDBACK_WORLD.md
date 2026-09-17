# Feedback — World AgentKit, AgentBook and World ID, from one integration

Written while building ACR's human-denominated manipulation bound: a benchmark
whose manipulation cost is counted in *people* rather than wallets, which needs
to know which wallets act for one verified human. That put us against AgentBook,
World ID proofs and the Developer Portal over roughly a week.

Everything in sections 1 and 4 is first-hand and measured — each item names the
command or the file that shows it. Sections 2 and 3 are marked where they need
the operator's own Portal and Sandbox session rather than guesses from us; a
feedback document with invented complaints is worth less than one with honest
holes.

Addresses and numbers were observed on World Chain mainnet (eip155:480) on
2026-09-09.

---

## 1 · AgentKit docs and integration flow

**1.1 — AgentBook ships Solidity, not an ABI artifact.** The AgentKit repo
contains the contract source but no compiled ABI JSON, so an integrator in any
non-Solidity language has to hand-write one. We did, and deliberately kept it to
the two view functions we call so there is less to drift
(`packages/acr_oracle_client/acr_oracle_client/agentbook.py`). It works, but it
means every integrator independently re-derives the same artifact and any of them
can get it subtly wrong.

*Suggestion:* publish `AgentBook.json` (ABI only) as a release asset or an npm
export. It costs one line of build config and removes a whole class of
integrator error.

**1.2 — The `agentkit` proof header's payload fields are not enumerated.** The
SDK reference documents the header *name*, that the value is base64-encoded JSON,
and that "eip155:* payloads are reconstructed into a SIWE message" — but not the
field names inside that JSON. We implemented against CAIP-122 / EIP-4361,
because those are the standards the docs name, and flagged the inference in the
code rather than burying it (`services/index_api/index_api/humanid.py`, the
`AgentKitVerifier` docstring). If a real header ever fails to parse, that one
function is where we'll look first.

*Suggestion:* a five-line worked example of the decoded payload in the docs —
one real header, base64 decoded, fields labelled. That single example would
remove the guess entirely.

**1.3 — The deployment constants are easy to find, and that's good.** The
mainnet address `0xA23aB2712eA7BBa896930544C7d6636a96b944dA` and the chain id
480 were unambiguous, and a public RPC
(`https://worldchain-mainnet.g.alchemy.com/public`) answered without a key. We
hardcoded both as constants rather than making operators configure them, which
is only possible because they're stable and documented. Worth keeping.

---

## 2 · Developer Portal — navigation, search, product discovery, debugging

> **Needs the operator's own session.** This section is deliberately empty rather
> than filled with plausible-sounding complaints. The Portal work on this project
> — app registration, obtaining the app id, the Sandbox toggles — was done by the
> operator, not by the engineer writing this file, and inventing navigation
> friction we did not hit would be both dishonest and useless to the people who
> built it.
>
> To complete: app creation and naming flow; where the app id surfaces and how
> obvious it is; whether search found the AgentKit docs from the Portal;
> discovering that AgentBook exists at all; what debugging information the Portal
> offered when a proof was rejected.

---

## 3 · Sandbox states, proof flows, test users, errors, edge cases

> **Needs the operator's own session.** Same reasoning as section 2. Our code
> paths for Sandbox are real — every identity is flagged `sandbox: true` all the
> way onto the chain, and `/humanid/info` reports the backend so that "verified
> human" cannot be read as more than it is — but we exercised them against our
> own dev verifier and fixture roster, not against live Sandbox identities.
>
> To complete: how a test user is created and reset; whether Sandbox and
> Orb-verified proofs are distinguishable at the API level (we assume yes and
> flag it explicitly, but never confirmed); the error shapes a rejected or
> expired proof returns; whether a nonce is required or proofs are replayable.

---

## 4 · What was confusing, missing, broken, or hard to test

**4.1 — There is no supported path from a human to their wallets.** `AgentBook`
exposes `lookupHuman(address agent) → uint256 humanId`: wallet to human. The
reverse — enumerating a human's fleet — needs scanning `AgentRegistered` across
the chain, and the public RPC **caps `eth_getLogs` at 100 blocks**:

```
"You can make eth_getLogs requests with up to a 100 block range."
```

World Chain head was 34,807,965 and AgentBook was created at 27,053,063. That is
7.75M blocks, or ~77,500 sequential requests, to answer "which wallets are this
person's". We could not do it, and said so in code rather than shipping something
that looked like it worked: the reverse reader raises `NotImplementedError` and
the resolver stands down to its fixture roster with a warning.

We got our test data from the explorer's transaction index instead — 200 calls
with selector `0x803a100d`, all relayed from `0xb6b007655859f165534bf3f10a44122746173bd2`,
with the registered agent in the first calldata word. That works but it is not an
API, and it would not survive the explorer changing.

*Suggestion:* either a `lookupAgents(uint256 humanId)` view, or an indexed
subgraph/API for `AgentRegistered`. Any system that wants to reason about a
person's fleet rather than a single wallet needs this, and fleet-level reasoning
is most of why a developer reaches for AgentBook.

**4.2 — That a registered fleet is already public deserves more prominence.**
`AgentBook` publishes `wallet → nullifier` on a public chain, so anyone reading
`AgentRegistered` can group a person's wallets. That is a reasonable design
choice, but it is easy to integrate against while assuming the opposite. We
caught it late and had to narrow a privacy claim we had already written: our own
rotation scheme prevents ACR's tape from becoming a *second* publication of that
durable identifier, and it cannot make the first one private.

Measured, to be concrete: two of the addresses we tested return an identical
`humanId`, so that fleet relationship is readable by anyone.

*Suggestion:* one sentence near the top of the AgentBook docs — "registration is
public; `AgentRegistered` links wallets to a durable human identifier on-chain."
Integrators building privacy claims on top will either adjust or choose
differently, and both are better than finding out afterwards.

**4.3 — `humanId` is a `uint256`, and it is not a small number.** Real values we
read are ~10^76, which is fine on-chain but overflows a JavaScript `Number` and
loses precision silently in any JSON round trip that doesn't treat it as a
string. Nothing in the docs warns about it.

*Suggestion:* note it, and prefer `bytes32`/string at API boundaries in examples.

**4.4 — What worked well.** The contract surface is small and stable enough to
hand-write an ABI against and trust. A single point lookup with no auth, no key
and no rate limit made the integration testable from a shell, which is a much
lower barrier than an SDK-only path would have been. And the separation between
a nullifier and a wallet is the right primitive — it let us build a grouping the
cleaning stack could cap without ever storing a durable identifier ourselves.
