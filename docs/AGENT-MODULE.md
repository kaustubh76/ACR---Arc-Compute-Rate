# Module A — the agent card, and a quota denominated in people

*Measured on `feat/agent-card-gateway` at `45c64e6`, 2026-09-12: 661 pytest (0 skipped),
ruff clean, `verify_claims.py` green, CI 6/6 (run `34681436811`).*

Companion to `WORLD-MODULE.md`. That document designs the human layer; this one spends it.
Module A is three things that compose: a **screen** on agent-to-agent traffic, a signed **card**
that says which agent is calling, and a **rate limit that counts humans rather than keys**.

Read the two limits first. Both are deliberate, and both are the kind of thing a reader will
otherwise discover by being surprised.

> **The carded tier is evadable, by design.** Anyone can mint a card — that is what
> permissionless means — so a per-card limit is a per-key limit, and keys are free. An agent that
> wants more than its budget mints a second key and gets a second budget. The card buys
> *attribution*, not scarcity. Only the human tier is scarce, and claiming a human is optional.

> **A human-bound card stops verifying when the window rolls.** Cluster ids are
> `keccak(nullifier, salt, window)`, so the same person's id changes completely every 7 days.
> Current window **2958**; the next roll is **2026-09-17 00:00:00 UTC**. A card minted before a
> roll and presented after it is refused — correctly — and the gate says *re-mint*, not *your
> claim is false*.

---

## 0 · The hole this closed, and it was measurable

Before this module — at `17ae570`, the commit this branch starts from — every rate-limit call
site in `app.py` passed an identity except one:

```
app.py:889   ratelimit.check(request, "graph")                          # no ident
app.py:946   ratelimit.check(request, "humanid", session_ident(...))
app.py:1398  ratelimit.check(request, "limits", req.address)
```

It now reads, at `app.py:909` — the line moved down by exactly the 20 net lines this module
inserted above it:

```
ratelimit.check(request, "graph", agent.ident if agent else None)
```

`ratelimit.py` explains at length why that matters: readers arrive through one Vercel proxy, so
the host bucket is a **global** limit wearing a per-person costume. `DESK_BUDGETS["graph"] =
(300, 3600)` was therefore unreachable code — the per-caller budget for the endpoint that spends
our Studio quota did not exist. It needed no new budget key. It needed an identity to key on.

**And an identity that costs nothing does not fix a quota, it renames the problem.** That is why
the card can claim a human cluster and the gate verifies the claim on chain: the limit then keys
on the person. Three wallets belonging to one human land in one bucket; a wallet belonging to
someone else lands in another. Asserted in a test, and demonstrated against Arc — possible only
because `HumanIdMirror` went live the day before.

## 1 · The card — the domain names no contract, and that is the point

`packages/acr_oracle_client/acr_oracle_client/agentcard.py` (297 lines). EIP-712, domain
`("ACR Agent Card", "1")` — the free slot in an idiom four domains already follow (`ACR Oracle`,
`ACR AttestationRegistry`, `ACR Receipt Mirror`, `ACR Human Id Mirror`).

```
AgentCard(
  address agent,         // the signing key — this IS the agent id
  string  name,
  string  role,          // maker | taker | poster | owner | reader
  string  audience,      // the service this card is FOR
  bytes32 scopeHash,     // keccak of the sorted, de-duplicated scope list
  bytes32 humanCluster,  // CLAIMED cluster; 0x0 = no claim
  uint64  issuedAt,
  uint64  expiresAt
)
```

`role` reuses the venue's own `_ROLE_WALLET_FIELDS` vocabulary (`signer.py:248`) plus `reader`, so
the card's roles and the service accounts are one taxonomy rather than two.

### What the missing `verifyingContract` costs

The four existing domains each bind to a deployed address, because a contract verifies them. A
card is verified by whoever reads it, so there is no address to name — and a bare
`{name, version, chainId}` domain is valid at **any** verifier on that chain. Two costs, both paid
inside the struct:

- **Replay at another service.** Paid by `audience`: a card addressed elsewhere is refused here.
  This is what stands in for `verifyingContract`.
- **Replay at this service, inside the window.** A bearer credential is replayable until it
  expires, so `MAX_TTL_S = 900` bounds it — enforced at the signer *and* at the gate, because a
  hostile agent does not call our `mint()`. `CLOCK_SKEW_S = 30` absorbs honest clock drift.

A nonce per call would be stronger and is the wrong trade: an agent cannot afford a round trip
before every request. Freshness is carried inside the signed message instead, which is the same
choice the AgentKit verifier makes.

**There is no `ACR_AGENT_MAX_TTL_S`.** The bound is a constant, not a setting, deliberately: the
only direction anyone ever moves a TTL ceiling is *longer*, and a configurable replay window is a
footgun whose blast radius is every card ever signed.

## 2 · The gate — five refusals, in order

`services/index_api/index_api/agentgate.py` (378 lines). A FastAPI `Depends` mirroring
`require_payment` (`x402.py:613`) and `require_human` (`humanid.py:594`), setting
`request.state.agent` beside `.payment` and `.human`.

1. **The signature recovers to `agent`** — else 401. Everything else in the card is a claim *by*
   that key, so this is the only check whose failure means "you are not who you say".
2. **`audience` is ours** — else 401.
3. **`role` is known** — else 401.
4. **The window, and the bound on it** — expired, not-yet-valid, inverted, or longer than
   `MAX_TTL_S`: 401.
5. **The human claim, if one was made** — `clusterOf(agent, current_window())` on Arc must equal
   `humanCluster`. A mismatch is a **refusal, not a downgrade**: a card claiming a human it cannot
   prove is worse than one claiming none.

`cluster_of` (`humanid.py:284`) already existed and the service had never read it. The gate is its
first consumer.

### The third state — "we could not check"

An unconfigured or unreachable mirror is neither a valid claim nor a false one. The gate declines
the human tier, says which of the two happened, and **never upgrades on the strength of a claim
nobody verified**. `/agent/info` reports `human_binding_verifiable` for exactly this reason: a
gate that cannot check claims and a gate handing out the tier freely look identical from outside.

One wrinkle worth naming: `HumanIdMirrorClient.configured()` requires a signer as well as an
address, because that class both reads and writes. The gate only reads — so a read-only deployment
reports claims as unverifiable. That is stated rather than worked around by keeping a second,
read-only copy of the `clusterOf` call — one chain read with two implementations is a drift
that no test would catch until the two disagreed in production.

## 3 · Three tiers, and only one of them is scarce

```
anonymous   no card              -> the host ceiling, which is global behind a proxy
carded      a signed card        -> per-KEY, and keys are free (see the warning above)
human       a confirmed cluster  -> per-PERSON, and people are not free
```

`/graph/query` takes an **optional** card: with one, the rate-limit ident is the cluster when
human-bound and the agent address otherwise. Optional because breaking the public tape read is
not a trade worth making for a tighter quota.

**And a verified identity is excused the host ceiling, which is what makes the tiers real.**
`ratelimit.check` applies the host bucket *as well as* the per-identity one, so for a day a card
bought a second constraint rather than an escape from the shared one: the carded caller still
queued behind every stranger on the same proxy address. That is backwards. Passing
`verified=True` now returns once a cryptographically proved identity has passed its own budget —
and *only* a
proved one. A desk address out of a request body or a session token must never set it, because
those are rotatable, and the ceiling would then be free to evade.

Ten agent-facing routes carry an optional card now rather than one. Nine of them are reads that
were previously unmetered, and they stay unmetered **for anonymous callers** — measured, not
assumed: `/api/tape` refreshes every 30 seconds and fans out one `/rating/{seller}` call per
seller, so a single reader drives on the order of a thousand upstream calls an hour through one
proxy address. Any host ceiling worth picking would stop the desk before it stopped an abuser.
The limiter therefore runs where there is an identity to limit, which is also the honest form of
the argument: the card is what creates the identity.

## 4 · The screen, where it applies, and why it fails closed

`services/index_api/index_api/armor.py`. Google Cloud Model Armor over its REST surface, both
directions — `:sanitizeUserPrompt` and `:sanitizeModelResponse`.

**It applies to `POST /graph/query`, for carded callers, in both directions.** That sentence is
the whole of section 4 and it was absent for a day: the module shipped with **zero production call
sites**, so `/armor/info` would have reported `screened: 0` forever while three places in `app.py`
asserted a screen "sitting on agent-to-agent traffic". The module was the easy half. A screen
nobody calls is the same defect as an unreachable rate-limit budget, which is what Module A was
built to fix — committed twice, one layer apart.

Two scoping decisions, both deliberate:

- **Carded callers only.** `armor.py` screens *agent-to-agent* traffic, and a browser reader
  arriving through the Vercel proxy is not that. Roughly a thousand of those reach `/graph/query`
  every hour, so screening them would mean one expired service-account key turns the public tape
  into a blank page — with `/armor/info` correctly reporting that the screen did its job. So the
  card buys two things rather than one: **a bucket of your own, and a screened reply.**
- **After the limiter, not before.** A screen in front of an unmetered caller is a new amplifier.
  A caller sending injections should spend budget doing it.

Text is capped — 4 096 characters on a request, 16 384 on a reply — and `/armor/info` publishes
both numbers, because a payload past the cap is **not inspected** and a reader should not have to
assume otherwise.

It fails **closed** on timeout, error body, unparseable shape, and unrecognised
`filterMatchState`. The last one is the interesting case: an unparsed response is precisely where
admitting traffic is worst, because it is the state an attacker can most plausibly induce.

Three statuses, because three different people need to look in three different places:

| condition | status | whose problem |
|---|---|---|
| the request was refused | **403** | the caller's own input, understood and declined. `400` would read as "malformed" and send them to rewrite a query that was fine |
| the reply was refused | **502** | nobody's fault but the upstream's. The caller did nothing wrong and we will not relay what came back |
| no verdict reached | **503** | ours. We could not inspect it, so we will not serve it — and it is transient |

Verified against the live `EthOnline_Project` template in `asia-south1`: prompt injection
`MATCH_FOUND` at `LOW_AND_ABOVE`, benign text clean in both directions. `google-auth` is an
optional `armor` extra (mirroring `circle`), so the base image still builds with no GCP
credentials, and `build_screen` falls back to a six-pattern `LocalScreen` floor.

`/armor/info` reports which backend answered and never the template's thresholds — those live in
the template, where an operator can change them without a redeploy, so a copy here would be a
second source of truth that goes stale silently.

## 5 · Configuration

| variable | meaning |
|---|---|
| `ACR_AGENT_AUDIENCE` | the audience this gate accepts (`acr-index-api`) |
| `ACR_ARMOR_MODE` | `auto` \| `local` \| `gcp` \| `off` |
| `ACR_ARMOR_PROJECT_ID` | GCP project |
| `ACR_ARMOR_LOCATION` | **no default** — Model Armor is regional and a wrong region 404s on the template, which reads like "the template does not exist" |
| `ACR_ARMOR_TEMPLATE` | template id |
| `ACR_ARMOR_CREDENTIALS_FILE` | a **path** to a service-account JSON, never the JSON |
| `ACR_ARMOR_TIMEOUT_S` | default 10.0 |

**The production image must install the `armor` extra.** `Dockerfile`'s `UV_EXTRAS` carries
`--extra circle --extra armor`; without the second, `google-auth` is absent, `ModelArmorScreen`
cannot mint a bearer token, and `build_screen` falls back to the offline floor — an image
reporting a screen it does not have, which is the exact failure `/armor/info` exists to prevent.
Note `render.yaml` pulls a **prebuilt image**, so this needs a build and a push, not a merge.

**Model Armor is IAM-gated and rejects API keys outright.** There is no key-shaped credential for
it. And `gcloud auth application-default login` mints a *user* credential, which is worthless in a
container — ADC is a development convenience, not a deployment credential.

## 6 · Checking it worked

```bash
uv run pytest packages/acr_oracle_client/tests/test_agentcard.py \
              services/index_api/tests/test_agentgate.py \
              services/index_api/tests/test_armor.py -q      # 25 + 19 + 18
uv run pytest -p no:cacheprovider                            # 661, 0 skipped
uv run ruff check packages services scripts redteam
uv run python scripts/verify_claims.py
curl -s "$ACR_API/agent/challenge" | jq .                    # how to mint one
curl -s "$ACR_API/agent/info"      | jq .human_binding_verifiable
curl -s "$ACR_API/armor/info"      | jq .backend             # `gcp`, or it fell back
```

End to end against the live chain, not a mock: present a card claiming the demo fleet's cluster
and confirm **human-bound**; present the same card claiming another human's cluster and confirm
**401**; present two wallets of the same human and confirm **one bucket**; present a card for
another audience, and one with a 30-day TTL, and confirm both refused.

## 7 · The rotation trap, found by walking into it

The fleet's cluster was `0xd9e05794…` in window 2957 and `0x5bf3b922…` in 2958 — no
resemblance, because the window is hashed in. My first end-to-end run used the id I had
written down two days earlier, and the gate refused it, correctly.

An agent that caches its cluster id is by far the likeliest mistake here. So a mismatch that
matches the **previous** window is reported as *re-mint the card* rather than *your claim is
false* — the difference between an actionable 401 and a mysterious one
(`agentgate.py:275-291`). The same silent-rotation shape appears in the terminal's human
resolution and is handled there too.

## 8 · What stays unfinished, deliberately

- **Nothing here is deployed.** Measured 2026-09-12 against `acr-api-1fto.onrender.com`: both
  `/armor/info` and `/agent/info` return **404**, because this branch is unmerged — so production
  does not merely lack `ACR_ARMOR_*` and `ACR_AGENT_*`, it does not carry the code. The ordering is
  deliberate: turning on a fail-closed screen in front of a live API is an operator decision with a
  blast radius, not a side effect of a merge.

  ```bash
  curl -s https://acr-api-1fto.onrender.com/armor/info   # {"detail":"Not Found"} until deployed
  ```
- **Malicious-URI and SDP filters are NOT SET** on the template. Malicious URI is the one I would
  enable next: a reply carrying a hostile link is exactly the "replies contain no malicious data"
  requirement, and responsible-AI filters will not catch it.
- **No registry, no revocation.** A card cannot be cancelled before it expires; the 15-minute
  bound *is* the revocation window. A registry would fix that and would also make the scheme
  permissioned, which is the property being bought here.
- **`scopeHash` is signed and enforced against nothing.** It is in the struct, it is in the
  signature, and `AgentGate.verify` has no scope step. Enforcing it needs a per-route scope map,
  which is a design decision rather than a wiring one. `/agent/whoami` therefore reports
  `scope_enforced: false` out loud, so it cannot quietly become a field everyone assumes is
  checked *because* it is signed.
- **The MCP server does not present a card**, and it is the most natural consumer — an agent
  calling ACR is literally what it is. `mcp/package.json` carries only the MCP SDK, so signing
  in-process means a new dependency and a rewritten `package-lock.json`; a newer npm silently
  rewrites that file into a form CI's older npm refuses. Not a risk worth taking on submission
  night. The buyer agent (`apps/agent/src/card.ts`) and `scripts/verify_live.py` present cards
  instead.
- **The Terminal deliberately presents no card, and this one is a design choice rather than a
  deferral.** It was the obvious candidate — viem and a key are already there. But every human
  reader shares that one server-side process, so one card would mean one identity and therefore
  **one rate-limit bucket for every reader at once**, recreating the global-limit-behind-a-proxy
  problem the card exists to fix. A website's proxy is not an agent.
- **Circle custody cannot sign cards.** `signer.full_eip712_json` hardcodes a four-field
  `EIP712Domain` including `verifyingContract`, and this domain has three. `sign_card` refuses a
  `CircleWalletSigner` outright rather than producing a signature that would recover to the wrong
  address. Fixing that function is not a card change: it signs every Circle-custody message in the
  system — prints, attestations, both mirrors — and getting the domain derivation subtly wrong
  means the oracle goes quiet with no local error, because a bad signature is a revert on chain.
  It wants its own commit and a live posting run.
