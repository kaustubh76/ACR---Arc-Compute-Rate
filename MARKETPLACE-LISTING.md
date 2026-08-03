# Circle Agent Marketplace — the submission, field by field

**Form:** <https://forms.gle/7YFzvdmMcn1JH5tF6>
(linked from <https://developers.circle.com/agent-stack/agent-marketplace/get-listed>)

Copy each block below straight into the matching field.

---

## Status — submitted 2026-08-04

The Google Form is in. Circle also said, in their Agent Stack session Q&A:

> "Yes, you can absolutely list as a seller on the testnet Agent Marketplace
> right now by connecting your wallet to Arc Testnet and registering your agent."

**Taking them at their word, and saying so attributively.** That phrasing does
not match any surface I can reach, and I want the record to be precise about
which parts are Circle's claim and which are measurement:

| | |
|---|---|
| Circle says | testnet listing is supported today |
| The public Discovery API says | **958 listings, every one on a mainnet chain.** `network=eip155:5042002` → 0. `testnet=true` is silently ignored and returns the same 958. `api-sandbox.circle.com` 404s. |
| agents.circle.com says | no wallet-connect, no `/register`, no `/sell` — it links the same Google Form |

Both can be true: their answer may describe an internal or unreleased surface,
or it may have conflated *agent wallet* creation (which genuinely is Arc Testnet,
via `circle wallet login`) with *seller* listing. The form response settles it.

**What the docs say until then:** that we have submitted, and that Circle states
testnet listing is supported — attributed to them. Not that ACR *is* listed. A
judge can query that Discovery API in ten seconds, and a claim they can disprove
costs far more than the listing would have gained. The moment a listing is
confirmed, every doc gets updated to say so.

## Endpoint URL

```
https://acr-api-1fto.onrender.com/prints/ACR-INF
```

*(The whole catalog of 13 priced resources is at
`https://acr-api-1fto.onrender.com/marketplace/catalog` — mention it in
"Anything else?" below.)*

## Payout wallet address

```
0x8366968f84a343CF70941EBe858428643d825cb0
```

This is a **Circle developer-controlled wallet** (the project's treasury), not a
raw EOA — which should make the sanctions screen straightforward.

## Description

```
ACR (the Arc Compute Rate) is a manipulation-resistant reference rate for
machine services — the "SOFR for machine commerce". It publishes three hourly
indices on Arc: inference ($/1k tokens), GPU compute ($/GPU-sec) and data
egress ($/MB).

Every print ships three numbers, not one: the constant-quality rate, a
bootstrap confidence interval, and an attack-cost-per-basis-point — the USDC an
attacker must burn to move the print by 1bp. Prints are EIP-712 signed by a
Circle developer-controlled wallet and posted on-chain to ACROracle, where a
cash-settled futures venue (ACRFutures) settles against them.

Agents buy the rate per query over x402 at $0.0001, discover it from a
Bazaar-shaped catalog carrying input/output JSON schemas, and can require an
on-chain ERC-8004-style seller attestation before paying.
```

## Primary Service Category

```
FINANCIAL_ANALYSIS
```

*(Their own taxonomy — 447 of the 958 listings sit in this category, and it is
the right bucket for a price index. The Discovery API filters on it.)*

## Number of Endpoints

```
13
```

Five endpoint families expanded per index: `/prints` (1), `/prints/{index}` (3),
`/curve/{index}` (3), `/vol/{index}` (3), `/seller-scores/{index}` (3).

## Pricing Model

```
Flat per-request nanopayment: $0.0001 USDC per query, every endpoint, no tiers,
no subscription, no minimum. Settled through Circle Gateway (scheme "exact",
GatewayWalletBatched) on Arc — network eip155:5042002, USDC at the native
predeploy 0x3600000000000000000000000000000000000000.
```

## Contact Name

```
Kaustubh Agrawal
```

## Endpoints OpenAPI spec (optional file upload — PDF / doc / spreadsheet)

The spec is served live as JSON:

```
https://acr-api-1fto.onrender.com/openapi.json
```

The form only accepts PDF/document/spreadsheet, so if you want to attach it,
print that URL to PDF from a browser (Cmd-P → Save as PDF). It is OpenAPI 3.1.0
covering 28 paths including all five paid families. Optional — but their docs
say it raises the chance of listing, and we already publish it, so it is worth
the two minutes.

## Endpoints Documentation URL

```
https://arc-compute-rate.vercel.app/developers
```

## Anything else?

```
Two things worth flagging.

First, this service runs on Arc TESTNET (eip155:5042002), and your Discovery
API currently returns nothing for that network — every listing I can see is on
a mainnet chain. If testnet services cannot be catalogued, I would genuinely
like to know the path for an Arc service to become discoverable, and whether
that changes when Arc mainnet lands. Happy to be told no; I would rather have
the real answer than guess.

Second, the listing may be more useful than its size suggests: the catalog at
/marketplace/catalog is Bazaar-shaped with per-resource input/output JSON
schemas, and each item carries an on-chain attestation anchor from an
AttestationRegistry on Arc, so a cautious buyer agent can require an attested
seller before paying. The endpoint is kept continuously awake (the host is a
free tier that sleeps, so the service knocks on its own door every 60s) and its
liveness is gated by a public check — `make verify-live` in the repo.

Repo: https://github.com/kaustubh76/ACR---Arc-Compute-Rate
```

---

## After you submit

Tell me and I will:

1. watch `/marketplace/receipts` for a payer that is **neither**
   `0x784e6d2d…` (our CI buyer) nor `0x71e140d9…` (our own agent wallet) — a
   third payer is the only real proof of discovery;
2. keep the endpoint reachable, since listings are health-checked continuously
   and "stay listed only while reachable";
3. record whatever answer comes back in `docs/WALLETS.md` and the session
   questions, whichever way it goes.

## The other registries Circle points sellers at

From <https://developers.circle.com/agent-stack/agent-nanopayments/seller-integration-tools>.
Worth trying in this order — **Proceeds is the only one whose docs mention Arc**:

| Registry | URL | Why it might take us |
|---|---|---|
| **Proceeds** | <https://myproceeds.xyz> | Circle's docs say it supports "Arc and other blockchains" — the best odds for a testnet-Arc service |
| **x402scan** | <https://www.x402scan.com/> | "a registry for x402 and agent-native APIs" |
| Blockrun | <https://blockrun.ai> | "helps API sellers list their services in a directory" |
| Sponge | <https://paysponge.com> | x402 + MPP, but **not** nanopayments — worst fit |

**These need a browser — I could not evaluate them from here.** All three are
client-rendered single-page apps: fetching them returns a shell, and
`myproceeds.xyz/docs` returns literally "Loading API reference…". I probed the
obvious API and docs paths on x402scan (`/api/resources`, `/api/services`,
`/docs`, `/about`) and every one 404s, so there is no unauthenticated endpoint
I can read.

So I do not know whether any of them accepts an Arc testnet service, and I am
not going to guess from a marketing line. **Ten minutes in a browser on
Proceeds first** (the only one whose docs mention Arc) would settle it. If any
offers self-serve registration, the details you need are the same three the
Circle form wanted — endpoint URL, payout wallet, description — all above.
