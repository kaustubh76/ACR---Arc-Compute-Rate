# The pitch · what to say over the eight slides

The deck is [`docs/pitch/deck.html`](pitch/deck.html) — eight slides, rendered by `make pitch` to
`docs/pitch/index.html` and `docs/pitch.pdf`. It carries almost no words on purpose. This file is
where the words live: what to say over each slide, what *not* to, the four questions a judge will
ask, and which rubric line each slide is arguing.

Nothing here is a script to memorise. It is the argument, written down once, so that saying it out
loud is recall rather than invention.

**The one sentence, if you only get one:** a manipulation-resistant price for machine work,
printed on-chain hourly on Arc, with a real economy already paying for it — an agent that buys the
number and trades on it, a venue that settles against it, and a public desk where anyone can take
the other side.

---

## The rule the deck obeys, and why you should too

**Every number on a slide is either permanently on-chain or CI-gated.** Settlement prices,
transaction hashes, the resistance table, the suite counts. Nothing that drifts — not the current
rate, not the receipt count, not the hedger's mark — appears anywhere.

That is not fussiness. The rate moves hourly, and a deck that states last night's rate will be
contradicted by the terminal you are about to open in front of the same judge. When you want to
point at a live figure, **point at it on screen** rather than quoting it from memory. The only
numbers safe to say out loud are the ones in the frozen-facts table at the bottom of this file.

---

## Slide by slide

Times are for a **3-minute** run. The whole thing is ~200 spoken words per minute of comfort, so
there is room to breathe. If you are cut to 2 minutes, drop slides 6 and 7 and speak the loop in
one sentence over slide 5.

### 01 · Machine commerce just got its SOFR · 0:00–0:15

> Every financial market runs on a reference rate. SOFR, Brent, LIBOR before it. Machine commerce —
> agents buying inference, GPU time, bandwidth — has none. We built one. It is printing on-chain
> right now, on Arc.

**Don't** open with the product name. The gap is more interesting than the acronym, and the name is
on the slide anyway.

### 02 · Agents buy compute at floating prices · 0:15–0:40

> Agents already pay per call for compute, and they pay whatever it costs that hour. With no
> benchmark there is nothing to hedge against, nothing to write a term contract on, and no basis
> for credit. And you cannot just average the payments: our own red team moved a plain
> volume-weighted average a hundred and twenty-two percent using eight thousand dollars of wash
> trades. An index you can bend for eight thousand dollars is not a benchmark.

**Don't** say "nobody has done this". Say what is missing and what it costs.

### 03 · We attacked our own index. It held. · 0:40–1:10

> So we attacked our own index, with that same budget and thirty-six thousand adversarial
> authorizations. The naive average moved a hundred and ten percent. ACR moved two tenths of one
> percent — five hundred and sixty-two times more resistant. Those figures are gated in CI, so they
> cannot quietly drift. And every print ships two more numbers besides the rate: a confidence
> interval, and the USDC an attacker must burn to move it one basis point. The index publishes its
> own price of corruption.

**Don't** say "unmanipulable" or "unhackable". Say *resistant*, and always name the budget the
resistance is measured against — a bound without a budget is not a claim.

### 04 · An agent already hedges on it. No human. · 1:10–1:45

*This is the slide the track is scored on. Give it the most air.*

> Here is who needs the number. An agent business that resells work at fixed prices but pays for
> inference per call is short the rate it pays. So it hedges. This one does it with no human in the
> loop: it pays a hundredth of a cent for the print over x402, settled through Circle Gateway from
> its own agent wallet; it reads its own book on the venue; and it trades the gap to its mandate.
> It holds 2.71 contracts, and that fill is a transaction on Arc you can open right now.
>
> The part worth pointing at: the venue fills it at the same print it just bought. That join lives
> in the contract — `ACRFutures` fills at the oracle's latest value and emits it — so it is not the
> agent's claim about itself.

**Don't** imply it trades constantly. An agent at its mandate correctly stops, and saying so is
stronger than pretending otherwise. If asked why it is not trading right now: it is 0.21 contracts
from a 2.5 mandate against a 0.25 minimum trade size, and it is at its collateral cap.

### 05 · Cash-settled futures on the rate · 1:45–2:10

> What settles on it: a cash-settled futures venue on Arc, three books, one per index. Cash
> settlement means no delivery, no GPU repossession, no seller cooperation — at expiry the venue
> freezes the freshest oracle print and pays the difference in USDC. And it refuses a print older
> than two hours, which is the important part: the feed now has a dependent that breaks when the
> feed breaks. Three rounds have already run their whole life on-chain — opened, traded for a week,
> expired, cash-settled at the print, collateral released.

**Don't** talk about notional. The venue is testnet-scale by design (10× multiplier); the mechanism
is the product, not the size.

### 06 · A benchmark is a number something settles against · 2:10–2:30

> That is the loop. Measure the price out of Arc's payment exhaust. Sell it to machines over x402.
> Settle contracts against it. The agent that hedges pays for the print and trades on it — and its
> trades, plus the sellers' on-chain attestations, become the exhaust the next print reads. Every
> arrow on that diagram is deployed.

**Don't** walk the boxes one by one. Say the loop as a sentence; the diagram is the evidence that
you are not hand-waving.

### 07 · Eight surfaces. All of them moving real USDC. · 2:30–2:50

> All of it runs on Circle. Gateway nanopayments on both sides of the gate. Four
> developer-controlled wallets — the press that signs prints, the maker, the taker, the treasury.
> User-controlled wallets so a stranger can trade the venue from their own PIN with Gas Station
> paying. An agent wallet and Circle's CLI for the hedger. Unified Balance Kit so the agent tops
> itself up. Signed inbound webhooks. A Discovery-shaped catalog with a public receipts tape. And
> we consume Circle's Skills and publish one back — `acr-hedge` teaches any agent this loop.

**Don't** read the chips aloud. Group them: payments, wallets, distribution.

### 08 · Check any of it in ten seconds · 2:50–3:00

> You can check all of it: the terminal, the press, the venue on arcscan, the repo. Three hundred
> and sixty-seven Python tests, sixty Foundry, ninety-five in the terminal. And the honest part,
> because you would find it anyway: the tape is a labelled simulator, and every payer so far is one
> of ours. The plumbing is proven; the demand is not. We say that on the site too.
>
> Stop whining. Hedge.

**Do** say the honest line without softening it. It is the most persuasive sentence in the deck,
because it tells a judge that every other sentence was checked the same way.

---

## The four questions, answered

### "Why Arc? Couldn't this run anywhere?"

Six dependencies, and they are mathematical rather than conveniences. The sharpest one: on a chain
with probabilistic fees, "what does it cost to move this index" is a Monte Carlo estimate. On Arc,
USDC is the gas token and fees are deterministic, so the attack cost is **arithmetic** — a number
you can print on every single observation. Then: Gateway is one canonical rail, so the estimator
observes the whole market rather than a self-selected slice; sub-second deterministic finality
gives clean tick timestamps; USDC as numeraire means no gas-token deflator polluting the signal.

And one thing only Arc forced us to build: Gateway settles nanopayments *off*-chain, so "this
wallet paid for the feed" normally exists only in a seller's ledger. `FeedAccessAttestor` signs
that receipt with the same custody wallet that signs prints, so an off-chain payment becomes an
on-chain right — which is what lets a venue rebate fees to the wallets that paid for its index.

### "Isn't the demand fake? You're paying yourself."

Yes, and we say so first. 36 paid queries, three payers, all of them ours. Growing that number
would buy more proof that the rail works and not one more customer, so we stopped growing it.

What is *not* ours: four wallets outside the entire operator set have traded the venue. They are
Circle user-controlled smart accounts, and they only exist because somebody walked the Public Desk
PIN flow in a browser. Two of them cleared in the settled rounds on slide 5.

What is real is the mechanism — real USDC, real signatures, real settlement, and an agent whose two
legs are separately checkable by a stranger. What is not real yet is demand, and the thing that
would fix it is named on the site: a dependent that is not us.

### "Who else uses it? Isn't the venue also yours?"

It is. The venue settling against the feed is a genuine dependent — settlement literally reverts on
a print older than two hours — but we deployed both, and we say that rather than implying
independence. The marketplace listing was submitted on 2026-08-04 and is **not** listed: Circle's
Discovery API serves 958 listings and every one is on a mainnet chain, with no Arc network present
at all. We do not claim to be listed, because the API disproves it in ten seconds and a judge who
checks should find us honest rather than caught.

### "What breaks when Arc goes to mainnet on September 16?"

Nothing structural. The estimator, oracle, venue and gate are all chain-first; the Arc-specific
assumptions are exactly the ones that make the manipulation bound a number at all. The open items
are operational and named in `docs/SUBMISSION.md` §8 rather than buried: the original deploy EOA is
still an authorized `ACROracle` signer (a one-line `setSigner` to revoke — deliberately left in
place and disclosed instead of quietly fixed), the press runs on a free tier that has overslept its
slot once, and the Terminal is pinned at Next.js 14.2.x.

---

## What each slide is arguing, against the rubric

The track scores *application of technology · presentation · business value · originality*, with a
standing question over all of them: **does it actually work autonomously?**

| Rubric line | Slides | What is being offered as evidence |
|---|---|---|
| Does it work autonomously? | **04** | The hedger does both legs — pays for the print, trades on it — with no human, and both legs are separately checkable by a stranger |
| Application of technology | 03 · 06 · 07 | Four contracts on Arc, eight Circle surfaces moving real USDC, a four-pillar estimator, 522 tests across four suites |
| Business value | 02 · 04 · 05 | A floating USDC burn is a real cost; a cash-settled future is the instrument that fixes it; three rounds have already paid out |
| Originality | 03 · 06 | An index that prints its own attack cost, and a benchmark defined by having a dependent rather than by being published |
| Presentation | the deck · 08 | Eight slides, one idea each, and four links a judge can check while you are still talking |

---

## Frozen facts — safe to state out loud

Permanent on-chain, or CI-gated. Everything else, point at on screen.

| Fact | Value |
|---|---|
| Chain | Arc testnet `5042002` · CAIP-2 `eip155:5042002` · USDC is the gas token |
| ACROracle | `0x4f00e3BDd224F4c4b4958D54cD774E84B9092609` |
| ACRFutures (venue) | `0x29d97c629a8278f7ec4218ab0bd8baa9182642fe` |
| AttestationRegistry | `0x23ae3E1A306824F0CBA0b6561cB7E5502f63dFb7` |
| FeedAccessAttestor | `0xe671a8E73900F1186448cFFeA9e730F5E50DFD47` |
| Settled ACR-INF series 2 | `0.49533` · 2 cleared · tx `0xf094befce4dc0d59a793cf934fd5265029a1088743ae5ffec932b4df25f8c917` |
| Settled ACR-INF series 1 | `0.49533` · 4 cleared · tx `0x5351bd0cc79c32fa93d7ff6ace55f8f71fc17828d440c75a9e0732273da545b1` |
| Settled ACR-INF series 0 | `0.49270` · settled 2026-08-01 |
| The hedger's fill | `buy 0.24 @ 0.49773` · tx `0x22772154ff8deb5ef43001af8c98fecd36ae2dc70cfe437965c90f68d0041834` · position 2.47 → **2.71** |
| Resistance ($8,000 wash) | naive VWAP `+110.8%` / `+107.1%` / `+122.5%` vs ACR `+0.20%` / `−1.02%` / `+2.39%` — **562× / 105× / 51×** |
| Resistance (12h eval) | naive VWAP `5703.9 bp` vs ACR `124.1 bp` attack-window error = **46×** |
| Attacker's cost | 36,000 adversarial authorizations, `$147.60` of fees burned |
| Settlement freshness bound | `MAX_SETTLE_AGE` = 2 hours, enforced on-chain |
| Print price over x402 | `$0.0001` per query |
| Suites | **445** py · **114** forge · **95** terminal · **10** agent · **426/426** glossary |

Two of the wallets cleared in those settled rounds are outside the operator set entirely — Circle
user-controlled smart accounts that only exist because somebody walked the Public Desk PIN flow.

---

## Related

- [`docs/DEMO-SCRIPT.md`](DEMO-SCRIPT.md) — the 3-minute **video** script, beat by beat, with the
  pre-flight. Different job: that one narrates the live product, this one narrates the deck.
- [`docs/SUBMISSION.md`](SUBMISSION.md) — the one-page status for judges, with every claim's evidence.
- [`docs/presentation.md`](presentation.md) — the long-form 13-slide deck, kept for anyone reading
  unattended who wants the depth this one leaves out.
- [`docs/methodology.md`](methodology.md) — the estimator spec, published before liquidity.
