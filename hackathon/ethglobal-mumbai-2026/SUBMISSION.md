# ETHGlobal Mumbai — submission copy

Bounty: **Arc — Arc Studio Continuity Track: Bring Your Project to Arc.**

Stated explicitly because Arc asks for it: *"Please be clear what bounty you are
submitting for as part of your submission."* Arc is one partner-prize slot.

---

## The one-liner

> This agent's wallet holds $0 — yet it never misses a bill, never overpays, and
> its budget earns yield until the second it's spent.

## What it is

ACR has printed the price of compute on Arc since September. **Float** is the
step where that price stops being a number to look at and becomes the thing that
**authorises money**.

An AI agent with a wallet has a worst case equal to its balance. Give it a
spending limit and the worst case is the limit. Neither asks the question an
overcharge actually fails: *is this a fair price?*

Float holds the budget in a vault instead. The agent's own wallet holds nothing,
permanently — there is a test that asserts it before and after every payment the
agent causes. Each request names the `printId` of the compute price it was quoted
against; the vault recomputes the fair total itself, refuses anything above a
band, pulls the **exact shortfall** out of a real yield venue and pays the seller,
**in one transaction**.

Three things follow that a spending limit does not give you:

1. **It prices the purchase.** Rig a seller to quote 3× and the chain refuses, in
   English, in a log anyone can read, with the fair counter-price attached.
2. **It funds just in time.** Idle float sits in a real ERC-4626 vault (Morpho
   Vault V2 on Arc). The money was earning yield until the block it was spent in.
3. **It parks what it cannot authorise.** Over the per-request threshold a request
   is not refused — a checkpoint opens on chain and waits for a verified human's
   single-use EIP-712 signature. An approval *widens* the band; it never removes
   it. A person can authorise paying more than usual. Nobody can authorise paying
   an unpriced amount to an unapproved seller.

## Why it is a Continuity project

ACR existed before this event: the estimator, the index, `ACROracle`,
`PolicyWallet`, the decision engine, the terminal, the subgraph. Float is new, and
the line is drawn with every number re-derivable from a named command in
[`CONTINUITY.md`](./CONTINUITY.md):

**8,383 insertions against 8 deletions, and 98.4% of the added lines are in files
that did not exist at the baseline.** For comparison, our ETHOnline continuity
disclosure reported 86.1% and 1.4% churn — the measurement is a habit here, not a
number assembled for this submission.

## How Arc Studio was used

Stated narrowly, because a narrow claim survives questioning and a broad one does
not. Full detail and the raw artifacts in [`float/studio/`](../../float/studio/).

- **It compiles the treasury policy.** The treasurer writes a sentence —
  *"Freeze the agent called waster. For everyone else, never pay more than 1%
  above the ACR fair price, keep two days of forecast spend liquid, and keep all
  of the idle float in the working vault"* — and Arc Studio emits the JSON. It
  changed exactly one field and correctly left three others alone. Its output is
  then **checked, not trusted**: our own validator refuses an invalid config
  before a transaction is built, and the chain keeps the last good policy. Studio
  said, unprompted, *"I didn't run it through a schema validator, but I checked it
  by eye"* — which is precisely the assurance the validator replaces.
- **It audits the vault**, including the human-checkpoint path, with findings
  triaged in commits that name the audit.
- **It hosts the dashboard**, byte-for-byte — verifiable with `arc-studio cat`.

What it did not do is listed too: it did not write the vault, the tests, the
keeper, the agents or the dashboard.

## What is demonstrably true

Every claim below is re-derivable by a command in the repo.

| claim | how to check |
|---|---|
| 335 contract tests, 41 unit tests | `forge test`, `npm test` |
| The agent's wallet holds nothing, before and after | `test_the_agents_own_wallet_holds_nothing_before_and_after` |
| A 3× quote is refused on chain with the fair counter-price | `npm run verify` T3 |
| The exact shortfall leaves the sleeve **before** the seller is paid, in one transaction | `npm run verify` T5 — proven by **log order**, because Arc's RPC has no `debug_traceTransaction` |
| The fair band is denominated correctly | `test_the_fair_band_is_denominated_in_usdc_not_wad` |
| Fifteen acceptance checks on a live chain | `FLOAT_NET=arc-testnet npm run verify` |
| An Eco **Sauce** program asks the Morpho venue whether it could deliver a shortfall, before anything is signed | `make float-sauce`, then `npm run verify` T13 — it is run in both directions, and fails unless the uncoverable amount is refused |
| That Sauce program cooks on a **Pot deployed on Arc**, not a simulated one | tx [`0xabb5df02…baf3be`](https://explorer.testnet.arc.io/tx/0xabb5df023e20f260b565b0c0cbb916d82e25e265c439a6ab6a43361632baf3be), 667,003 gas through Sauce's Kitchen (verified as `KitchenProxy`). The witness is that `simulate` no longer prints a `deployPot` step |
| The venue is still Morpho **Vault V2** — every `max*` returns zero and shares are 18 decimals against 6-decimal USDC | `npm run verify` T14. Asserted against the live vault with **no proprietary dependency**, so unlike T13 it also runs from a clone and in CI |
| The **USYC reserve sleeve** runs on Arc Testnet against a **stand-in fund**, because Circle's allowlist is a support ticket we could not clear during the event | The sleeve is the real contract ([`0x6D2A34ed…972E`](https://explorer.testnet.arc.io/address/0x6D2A34ed26C9e4E58062ecAb9fdD1A80E4b1972E)); the fund behind it is ours and named `SimUsycTeller` so the explorer says so. Real round trip: park [`0xc404de99…ffc40`](https://explorer.testnet.arc.io/tx/0xc404de99cc50ae4ed67a670a005c4332d6d18c4b02a55d0d68164490f54ffc40), pull [`0xc28846ab…f38f9`](https://explorer.testnet.arc.io/tx/0xc28846ab995daad67ff0871c01166708916df7dd03599ce53a354465beff38f9), `valueUsdc` 0 -> 999999 -> 499997. **We hold no USYC**: a staticcall of Circle's real Teller reverts `NotPermissioned()`, and `npm run verify` T15 reports that on every run |
| Our yield venue has **no timelock on any of its four gate setters**, and its owner and curator are one key | `venue.html`, written by Arc Studio's `morpho` skill; re-derive with `cast call <venue> "timelock(bytes4)(uint256)" <selector>` |
| The three pages are **driven, not read** — a shortfall probe, a payment picker, a span selector | Open `float/app/{venue,walk,index}.html`. The probe asks the live vault the same four checks the compiled Sauce program asks, and agrees with it: one cent below the sleeve's position says *can cover*, one cent above says *refused* |
| Pyth is **deployed but dormant** on Arc Testnet, so a pull oracle with nobody paying has no price at all | `index.html` reads it live; re-run `cast call 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729 "getPriceUnsafe(bytes32)" 0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a --rpc-url https://rpc.testnet.arc.io` and read the `0x14aebe68` revert as `PriceFeedNotFound()` |

## The number that makes the case

Nine providers serve the same open-weights model, `meta-llama/llama-3.3-70b`,
between **$0.000155 and $0.000783** per thousand tokens — a five-fold
disagreement about one product, measured 2026-11-05. That is why a fair price has
to be a *band*, and why the treasury carries that spread as its margin.

## Honest limits

- Prices are **published list prices** per provider, not executed fills. What the
  band constrains is what the vault will *pay*. Executed-price feeds are roadmap.
- The confidence interval is a **provider spread**, not a forecast error bound.
- Float adds **no yield of its own**; it shows accrued value, never a projected APY.
- The forecaster is deliberately simple and says *"no measured rate"* rather than
  inventing one.
- `FloatTestSeller` is ours and **says so in its own name**.

## AI use

Documented file-by-file in [`CONTINUITY.md` §6](./CONTINUITY.md), as ETHGlobal
requires. The short version: the implementation was written with Claude Code —
33 of 35 commits carry a machine-checkable `Co-Authored-By` trailer — Arc Studio
compiled the policy, and the product design, every architectural decision and the
corrections were the human's. The tension between Arc requiring an AI builder and
ETHGlobal cautioning against entirely-AI work is named there rather than avoided.

---

## Links to fill in at submission time

- **Arc Studio project URL**: https://studio.arc.io/app/b5aa43e1-4d5c-4d47-b079-dcc9aea0e557
  *(this is the right route — `/apps/<id>` and `/a/<id>` both 404 — but be told
  exactly what it does rather than discovering it. Anonymously it **302s to
  `login.circle.com/login/signout` with `fromURI` set to Studio's ROOT**, so the
  project id is dropped and even a signed-in visitor lands on the Studio home,
  not this app. And there is no public variant to offer: Arc Studio's own CLI
  guide says the preview "renders only inside the workspace, not a standalone
  link". The app is `b5aa43e1…`, "Onchain Agent Treasury Dashboard", and its
  workspace holds `index.html`, `walk.html` and `venue.html` — checkable without
  a login via the two hashing commands in `float/studio/README.md`, which now
  print both the workspace and repo hashes for each.)*
- **Public dashboard URL**: https://arc-compute-rate.vercel.app/float — live,
  200, no login. This is the **terminal's** float surface: it drives the vault's
  own twelve-rung refusal ladder against chain `5042002` through a `view`, so it
  signs nothing, spends nothing and needs no key.
  *(It is deliberately **not** the Studio-authored dashboard, and conflating the
  two would overclaim. Those three are `float/app/{index,walk,venue}.html` — each
  a single file, no build step, no server: open one in a browser and it reads Arc
  Testnet live. **Do not use `arccomputerate.in`**, which answers `200` with a
  registrar page titled "Your domain is suspended" — the status code flatters a
  dead domain.)*
- **GitHub**: https://github.com/kaustubh76/ACR---Arc-Compute-Rate
- **Architecture diagram**: `docs/assets/acr_float.preview.svg`
- **Video (2–4 min, 720p+, human narration)**: _pending_
- **Deployed contracts on Arc Testnet**: chain `5042002` — see the table below

### Deployed on Arc Testnet

Chain id `5042002`, explorer `https://explorer.testnet.arc.io`. Every number below
was read off the chain, not out of a log file.

| | address |
|---|---|
| FloatVault (the treasury) | [`0xb030e7e592eb2d8a989c7cbca01270b957bb4bdc`](https://explorer.testnet.arc.io/address/0xb030e7e592eb2d8a989c7cbca01270b957bb4bdc) |
| FloatPrintStore (the price feed) | [`0x02558098ba49e30868f6db15036c5dac326d7e3a`](https://explorer.testnet.arc.io/address/0x02558098ba49e30868f6db15036c5dac326d7e3a) |
| Erc4626Sleeve (the yield position) | [`0xdbecae19b2a082b51fc4f0df59cbffd1cb12ad14`](https://explorer.testnet.arc.io/address/0xdbecae19b2a082b51fc4f0df59cbffd1cb12ad14) |
| FloatTestSeller | [`0xf4e89e34ed6e1626a3410e1d49796779179915c1`](https://explorer.testnet.arc.io/address/0xf4e89e34ed6e1626a3410e1d49796779179915c1) |
| Morpho Vault V2 — **not ours**, Circle's Earn Kit discovers it | [`0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88`](https://explorer.testnet.arc.io/address/0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88) |
| Eco Sauce **Pot** — the pre-flight program's on-chain home, owner `0x64E21e01…` | [`0x0EfAcA8478ADe9B312de3EbB7AF4338f02f05FE5`](https://explorer.testnet.arc.io/address/0x0EfAcA8478ADe9B312de3EbB7AF4338f02f05FE5) |
| `scout`, the agent — **holds 0 USDC, before and after** | [`0x0420A5279cbD3257252Ba9CC524a2E09dd304E88`](https://explorer.testnet.arc.io/address/0x0420A5279cbD3257252Ba9CC524a2E09dd304E88) |

**All four are verified on Blockscout**, so the explorer shows the Solidity
rather than the bytecode, and the source you read on GitHub is provably the
source that is running. Blockscout verifies only on an exact bytecode match,
which is also why the one cosmetic revert-ordering fix we know about is listed
in `float/studio/README.md` as deliberately not applied rather than quietly
patched: changing the source would break this.

**The one transaction to open.** [`0x364723c6…72f9d`](https://explorer.testnet.arc.io/tx/0x364723c61d77084e180d99aeef088fe266f222b126bc9e7b2ac38de2f6072f9d),
block 70931234. Read its logs in order — this is the whole product in one
transaction, and the ordering is the claim:

| log | what |
|---|---|
| 25–29 | the Morpho vault unwinds the position |
| **30** | `Pulled(530250, 530250)` on our sleeve — requested and delivered, the exact shortfall and not a round number |
| **32** | USDC `Transfer` of `1055250` from the vault to the seller |
| 33 | `Receipt #2` — `jitFunded = true`, 4,000 units, quote $1.055250 against fair $1.050000, premium 50 bp |

The sleeve was pulled at log 30 and the seller was paid at log 32, inside one
transaction. Note the two figures differ: the seller received the full quote of
$1.055250, of which $0.530250 was pulled from the yield position and the rest came
from the buffer the vault already held. The vault pulled the **shortfall**, not the
payment — which is the difference between just-in-time funding and simply holding
money somewhere else. That $0.530250 was earning yield in the previous block. Arc's RPC serves
no `debug_traceTransaction`, so log order is the proof — which means anyone with
an ordinary node can check it, not just someone with an archive node.

**The refusal.** [`0xb746116a…9ffb2cd`](https://explorer.testnet.arc.io/tx/0xb746116ae09502f588a6763fb4ce91a99195eea7c05e5b5da83f947849ffb2cd),
block 70931213: `Denied`, code 10, reason **"quote exceeds ACR fair band"**, quote
`3150000` against fair `1050000`. A 3× quote refused on chain, in English, with the
fair counter-price attached.

**Live role state**, as the vault reports it:

```
owner / humanApprover / guestRegistrar / studioDeployer   0x64E21e01…f38d16
keeper                                                    0x3111B1a0…0f3597
executor                                                  0x7FAAC6F8…5183A0
wired()                        true    (one-shot, spent at deploy)
requirePolicyCheckpoint()      false
treasurerBinding()             0x00…00 (one-shot, deliberately UNSET)
receiptCount()                 2
guestDailyCap()                2000000 (2 USDC)
```

Two things that table is honest about. `humanApprover` is the deployer rather than
a separate human key, because `wire()` took all five roles at once and the World
half's approver key arrived afterwards; it is `onlyOwner`-rotatable and rotating it
is one transaction. And `requirePolicyCheckpoint` is `false`, so **the human-approval
and guest-enrolment paths are not exercised on this chain** — they are covered by 80
contract tests and a ten-leg local-chain walk, and the World submissions say which
chain they show. `treasurerBinding` is zero on purpose: it is one-shot from zero, and
a placeholder would permanently kill the human path.

### A known gap, disclosed rather than hidden

Arc's qualification block asks for *"a shareable Arc Studio project URL that
judges can open."* Our Studio project URL 302-redirects to `login.circle.com`
for anyone without a Circle account, and Arc Studio reports no public share
action; its preview host returns 403 unauthenticated. We are publishing the
dashboard to a public static host as well, so the app itself is openable by
anyone, and giving both links. If judges can open Studio project URLs directly,
the first link is the canonical one.
