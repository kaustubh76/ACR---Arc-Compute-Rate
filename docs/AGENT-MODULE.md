# Module A — the agent card, and a quota denominated in people

*Measured on `feat/agent-card-gateway` at `45c64e6`, 2026-09-12: 628 pytest (0 skipped),
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

## 4 · The screen, and why it fails closed

`services/index_api/index_api/armor.py` (352 lines). Google Cloud Model Armor over its REST
surface, both directions — `:sanitizeUserPrompt` and `:sanitizeModelResponse`.

It fails **closed** on timeout, error body, unparseable shape, and unrecognised
`filterMatchState`. The last one is the interesting case: an unparsed response is precisely where
admitting traffic is worst, because it is the state an attacker can most plausibly induce.

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

**Model Armor is IAM-gated and rejects API keys outright.** There is no key-shaped credential for
it. And `gcloud auth application-default login` mints a *user* credential, which is worthless in a
container — ADC is a development convenience, not a deployment credential.

## 6 · Checking it worked

```bash
uv run pytest packages/acr_oracle_client/tests/test_agentcard.py \
              services/index_api/tests/test_agentgate.py \
              services/index_api/tests/test_armor.py -q      # 25 + 19 + 18
uv run pytest -p no:cacheprovider                            # 628, 0 skipped
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
