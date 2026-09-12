# The 3-minute demo · recording script

One doc, one purpose: record the submission video from this, cold. The same script renders as a
teleprompter — big type, a running clock that highlights the beat you should be inside —
at [`docs/pitch/teleprompter.html`](pitch/teleprompter.html) (`make pitch` regenerates it from
`docs/pitch/video.html`; the words there are copied from HERE verbatim, so reword in this file
first). Every quoted phrase in the
SCREEN column was harvested from the production DOM on 2026-08-09 and **re-verified against the
live pages on 2026-08-10**, after the storefront, tenor curve, settled rounds, endpoints panel
and contract register had all landed — the drifts that pass found are folded in below. The WORDS
column is what the narrator says. Where a spoken line is a claim about the mechanism rather than text on screen, it
is marked *(narrative)* — the contract enforces it (`MAX_SETTLE_AGE`, CI-asserted), the screen
does not print it.

**The one sentence:** a manipulation-resistant price for machine work, printed on-chain hourly,
with a real economy already paying for it — an agent that buys the number and trades on it, a
venue that settles against it, and a public desk where anyone can take the other side.

---

## Pre-flight · the one thing with a clock on it

**The fill is already there. Check its age before you record.**

A fill was executed **10 Aug ~09:10 UTC** and sits in the hedger card's table 2:
`buy · 0.24 · 0.49773 · tx 0x22772154…`. The tape walks back ~7.9h, so it **ages out around
10 Aug 17:05 UTC (22:35 IST)** — restated from the fill's measured age (2.3 h at 16:57 IST)
rather than the estimate this section first carried. Record before then and table 2 is populated;
after, the card falls back to its own empty-row sentence and beat 4's fallback line covers it.

**There is no way to make another one today.** The agent finished that trade at its collateral
cap (3.00 USDC, `HEDGER_COLLATERAL_CAP_USDC`), so the next tick refuses with *"the top-up cap
leaves nothing to add"*. Raising the cap would work but is not a thing to do on submission day.
And the buy cannot be unwound through the agent wallet at all: `circle wallet execute` cannot
build a negative `int256`.

## Pre-flight · T-30min

1. Warm the press: hit `https://arc-compute-rate.vercel.app/api/terminal` until the payload says
   `"live": true`. A sleeping press downgrades every badge on camera.
2. Warm `/attack` once (one run to completion) so the estimator is hot and the demo run paces.
3. Open each beat page once: `/` · `/attack` · `/curve` · `/exchange` · `/sellers`.
4. Browser: clean profile (no extensions — inpage.js consoles are not ours but look like ours),
   100% zoom, window ≥1440px wide, **expert edition**, and **no workload set** (`acr-workload`
   absent from localStorage) — it gets set on camera; that is the point of beat 1.
5. Recorder at 60fps if available; the ticker rolls and the block-number press deserve it.

---

## The script

Speak the WORDS column as written. **450 spoken words ≈ 3:00** at 150 wpm — counting one hedger
variant and excluding the italic fallbacks, which are notes to you and are never read aloud. The
spare beats below the table *replace* a beat rather than add one, so the total stands. That
is tight: the live actions (the buy in 3b, the two chain reads in 5) run *under* the narration, so
speak through them rather than pausing, and if you run long, beat 6 is the one to shorten.

| # | time | screen · what you do | words |
|---|---|---|---|
| 1 | 0:00–0:25 | `/` home. Hero shows **“Machine commerce just got its SOFR: it prints its own attack cost.”** Scroll to *Today’s fixing*, click **PRICE YOUR WORKLOAD**, tap the *agent startup* preset, **done**. The three cards each gain a `yours ≈ $…/mo` line; a gold **YOUR BILL** chip lands in the masthead. | “Machine commerce just got its SOFR. Three live indices — inference, GPU, data — printed on-chain every hour on Arc. And it’s not a poster: tell it what you buy, and the whole paper re-prices in your money. That bill in the corner now follows me around the site, moving with the fixing.” |
| 2 | 0:25–1:00 | `/attack`. Click **$8,000**, then the run button; speak over the run; land on the verdict table (columns now read **naive VWAP error** vs **ACR error**). | “Here’s why the number is worth paying for. I’m funding an eight-thousand-dollar wash-trading attack against it, live. Watch the two error columns: the naive volume-weighted average gets bent; ACR cleans the fake volume, prices the attack, and barely moves — in our calibrated eval the naive average errs about forty-six times more. The attacker’s money is simply burned.” *Fallback: if the run is still pacing at cut time, the previous verdict table is already on screen — read that.* |
| 3 | 1:00–1:45 | `/curve`. The **quote corridor** — caption gives a per-index shape, and today it reads `ACR-INF contango +11.1 bp · ACR-GPU contango +5.6 bp · ACR-DATA flat 0.0 bp`; a **flat** book is a near-balanced lean, which is the words' "each index has its own shape" being literally true, so say nothing extra. Then the desk: series row, **Expiry**, then **SETTLED ROUNDS · CASH, FINAL** (three ACR-INF rows, `#2 · 0.49533`, `#1 · 0.49533`, `#0 · 0.49270`), then the tape. | “The print has a dependent: an on-chain futures venue that cash-settles against it. The maker quotes a real term structure off it — the corridor widens with tenor and leans on whichever book it is short, so each index has its own shape. *(narrative)* Settlement refuses a print older than two hours, so the feed has something that breaks when the feed breaks. And these rounds already ran their whole life on-chain: opened, traded for a week, expired, cash-settled at the oracle print, collateral released. The last one settled today.” |
| 3b | 1:45–2:05 | `/exchange`, top. The **LISTINGS** table. Click `/curve/ACR-INF` open, point at the terms, then press **buy this one · $0.000100**. The green line, the toast, the tape gaining a row, the **Sold** count ticking up (that listing already shows 1 from the storefront build, so on camera it goes 1 → 2). | “This is the storefront a buying agent discovers: thirteen priced resources, each carrying the exact terms the paywall enforces and the shape of what you get back. And it is not a price list. Watch: buy that one. Real Circle Gateway settlement, a hundredth of a cent, and there is the batch reference. The tape gained a row and the listing’s own sold count moved.” *Fallback: if the buy is refused, the row says why in red; read it and move on.* |
| 4 | 2:05–2:35 | `/exchange`, the **AUTONOMOUS HEDGER** card. Point at **1 · PRINTS IT BOUGHT** (rows of `0.0001 USDC · GW · <uuid>`), read the joint line on screen (“*The venue fills every trade at that same print, so the position below is that print, priced*” + the arithmetic), then **2 · FILLS IT TOOK**. | “Now the economy. This agent is a compute buyer, short the rate it pays, so it hedges — no human in the loop. Table one: prints it bought over x402, a hundredth of a cent each, settled through Circle Gateway. Those refs are Gateway batch IDs, off-chain, which is why the seller publishes this receipts tape at all. Table two is what it did with what it read: it bought a quarter of a contract at that print, on the public tape, transaction there to open. Both legs are public state — an off-chain receipt, an on-chain position — not a file we ask you to trust.” *Fallback: if table two has aged out (see the pre-flight note), it says so itself; read its own sentence and land the same line about the position being the durable witness.* |
| 5 | 2:35–2:50 | `/sellers`. The register's disclosure column now **derives** the four seller addresses from their labels (`sha256("acr-attest::" + label)` → address) and ticks each against the on-chain record — worth a half-second of hover, no words. Then press **READ IT FROM THE CHAIN**. The block number lands. Press it again. It lands **higher**. | “Everything so far came through our own server, so here’s the exit: this button asks the registry contract directly. There’s the answer, stamped with the block it was read at. Press again — the block moved. This site is live against Arc, not a recording of it.” |
| 6 | 2:50–3:00 | `/` home, hero + the ticking finality badge; scroll to the colophon's **ON-CHAIN REGISTER** (six addresses, arcscan-linked — the same register every page's footer now carries) or use the repo URL as the end-card. | “*(narrative)* Every tier of this site tells you how fresh it is and never fakes it. It runs today, it’s built for Arc mainnet, and the whole thing — contracts, agents, terminal — is in the repo. Arc Compute Rate.” |

## Spare beats · scripted swaps, ~20 s each

Three features shipped after this script was first cut and deserve a slot **if one opens** — a dead
beat-2 run, an aged-out beat 4, or a director's cut that drops beat 6. A spare *replaces* a beat;
it never extends the video past 3:00. Words counted like the main table (spoken at 150 wpm).

| spare | screen · what you do | words |
|---|---|---|
| **S1 · the plain edition** (43 words ≈ 17 s) | Any page. Click **PLAIN EDITION** in the masthead; the whole page re-sets; click back to expert. | “One more thing: this paper ships in two languages. Flip the masthead to plain, and every page re-sets itself in beginner English — same numbers, no jargon. That coverage is a test in CI: a page that loses its plain translation fails the build.” |
| **S2 · every endpoint answers** (44 words ≈ 18 s) | `/developers`, the **Endpoints** table (columns end in **Try**). Click the `/health` row — the JSON and latency land inline; the receipts roll below records the call. | “Under develop, every endpoint answers for itself. Click any free row — the response and its latency land right there, and the receipts roll below remembers your session. Thirteen GETs run from the page, and the paid rows say exactly why they won’t.” |
| **S3 · who is calling, and what screens it** (50 words ≈ 20 s) | `/developers`, **Endpoints**. Click **Try** on `/agent/whoami` — `tier: anonymous`. Then `/armor/info` — `backend: gcp · live: true · asia-south1`. Point at `screened` and `blocked`; both are non-zero because the demo script drove a real injection through the gate on 2026-09-12. | "Agents calling agents need a name and a screen — the paywall gives neither. No card: anonymous. A signed card: a key. A card the chain ties to a person: one budget for every wallet they own. In front of it, Google's Model Armor, which refused an injection by name." *Frozen: `pi_and_jailbreak`, `asia-south1`; point at the live counters, never read them.* |

## After

- Edit: trim dead air inside beat 2’s run; **never cut inside beat 5’s double-press** — the
  moving block is the evidence, and a cut would destroy it.
- Export ≤ 3:00. Place the link in `docs/SUBMISSION.md`’s video slot.
- At submit time, record the submitted commit hash at `docs/SHIP-CHECKLIST.md` step 10.

## What this script deliberately avoids

Live figures are pointed at by name, not by value — the rate, the bill, the burn counter and the
mandate all drift, and a narration that states yesterday’s number argues with today’s screen.
The only numbers spoken are frozen ones: $8,000 (a preset), ~46× (the calibrated eval-gate
figure), $0.0001 (the print price), two hours (the settlement freshness bound the contract
enforces).

**Frozen facts — safe to state, permanent on-chain:**

| fact | value |
|---|---|
| Settled ACR-INF series 1 | `0.49533` · 4 participants cleared · tx `0x5351bd0cc79c32fa93d7ff6ace55f8f71fc17828d440c75a9e0732273da545b1` |
| Settled ACR-INF series 2 | `0.49533` · 2 participants cleared · tx `0xf094befce4dc0d59a793cf934fd5265029a1088743ae5ffec932b4df25f8c917` |
| Settled ACR-INF series 0 | `0.49270` · settled 1 Aug 2026 |
| Venue | `0x29d97c629a8278f7ec4218ab0bd8baa9182642fe` |
| Curve base spread (1W, all indices) | `~50.4 bp`, widening to `~53.1 bp` at 8W |
| The hedger's fill | `buy 0.24 @ 0.49773` · tx `0x22772154ff8deb5ef43001af8c98fecd36ae2dc70cfe437965c90f68d0041834` · position 2.47 → **2.71** |

Both 1 and 2 were live ACR-INF books that traded for a week before expiring; settling them
released six cleared balances, two belonging to wallets that are not ours.
