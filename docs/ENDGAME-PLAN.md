# ACR Endgame — One Product, Full Circle Stack (ACTFUN demoted to roadmap)

**Deadline: Mon 2026-08-10 17:29 IST · Code freeze EOD Fri 08-08 (SHIP-CHECKLIST.md:12) · Sat = docs/deck/video only · Sun = ritual only**

---

## 1. Context and the honest ACTFUN verdict

Submission target: **Agentic Economy track**. Brief: *"Agents with clear decision logic tied to real signals; Autonomous spending, payments or settlement flows using USDC; Use of Agent Stack to connect agents to wallets, USDC payments and onchain actions; Use of Nanopayments, Paymaster or App Kits where relevant. Core products: Arc, USDC, Agent Stack, App Kits, Circle Wallets, Circle Contracts, Nanopayments, Paymaster."* Final submission: functional MVP on Arc, public repo, 3-min video, deck. No placeholders; every link works.

**ACTFUN verdict (user asked for the real review, three times — this is it): the on-chain launch is an over-feature for THIS submission. CUT from the build; keep as one roadmap line.**
- It scores **zero** on the rubric — tokens/launchpads appear nowhere in the brief, while **App Kits (named in the brief) had been sitting in "stretch, first cut"**. Priorities were inverted; this plan fixes that.
- The miners would be the **least agentic** thing in the repo (a timer script posting template jokes) sitting next to the genuinely agentic hedger — dilution, not reinforcement.
- Paying mine-fees to a meme launchpad does **not** fix the admitted circularity ("both sides of the book are us"); only third-party demand does (marketplace listing, foreign-wallet receipts).
- Brand risk with institution-flavored Circle/Arc judges is real; memorability is a **variance play, and you add variance when you're behind — ACR is not behind** (the attack lab is already the wow).
- Cost lands on the single most valuable remaining build day (undocumented unaudited contract, no ABI, 1-hour live event, panel + coverage + snapshot wiring).
- **Keep:** one deck/SUBMISSION roadmap line — *"post-hackathon: $GPOOR — a fair-launch community token on Arc's own launchpad, mined by complaining about real compute prices. Stop whining. Hedge."* Zero hours, zero risk, keeps the quirk + ecosystem signal + lifecycle story. Execute the real launch AFTER the hackathon when a community can actually mine it. The full launch playbook is preserved in the Appendix if the user overrides.

Strategic anchor: **Arc public mainnet launches Sept 16, 2026** — ACR pitches as *mainnet-day-one market infrastructure*, and the lifecycle story is carried by: mainnet timing + marketplace listing (submitted) + published skill + growing receipts + the $GPOOR roadmap line.

---

## 2. Analysis — the Circle stack audit (what's real today)

| Circle product | Status | Where |
|---|---|---|
| Gateway / x402 Nanopayments | **LIVE both sides** — seller gate + 2 real buyers, 34 Gateway-settled receipts (2 payers, both ours: 27 CLI buyer + 7 hedger) | `services/index_api/index_api/x402.py` (13 priced resources, Circle facilitator, fail-closed), `apps/terminal/lib/gatewayBuyer.ts`, `app/api/buy/route.ts`, `app/api/circle/balances/route.ts`, `apps/agent/src/payer.ts`, `receipts_live.jsonl` |
| User-controlled wallets | **LIVE** — PIN ceremony, SCA on ARC-TESTNET, faucet, approve→collateral→trade→withdraw→settle | `components/chain/PublicDesk.tsx` (941 ln) on /curve, `services/index_api/index_api/desk.py` (1120 ln), proxy `app/api/desk/[action]/route.ts` |
| Developer-controlled wallets | **LIVE, load-bearing** — 4 wallets; custody signs every oracle print; maker wallet OWNS the venue | `packages/acr_oracle_client/acr_oracle_client/signer.py` (`CircleWalletSigner`), `render.yaml` |
| Agent wallet + `circle` CLI | **LIVE** — the hedger: pays x402 for the print via `circle services pay`, reads its position, sizes gap to its 2.5-contract mandate, trades via `circle wallet execute "trade(uint256,int256)"` | `scripts/hedger.py`, `services/index_api/index_api/hedger.py` + `GET /hedger`, `HedgerPanel.tsx` on /exchange (it was on /curve too until 2026-08-07; two mounts meant one panel introduced itself twice on the demo path — `apps/terminal/app/curve/view.tsx:212-216`) |
| Agent Marketplace | **PARTIAL** — Bazaar-shaped catalog LIVE; listing form **submitted 2026-08-04, NOT listed** (Discovery API: 0 Arc-testnet listings) | `services/index_api/index_api/marketplace.py`, `MARKETPLACE-LISTING.md` |
| Circle Webhooks | **LIVE** — P-256 signature verify, pinned key | `services/index_api/index_api/webhooks.py`, `WebhookActivity.tsx` |
| Gas Station / Paymaster | **PARTIAL** — consumed by desk SCAs, VERIFIED via ERC-4337 `UserOperationEvent` paymaster topic; never configured by us | `scripts/desk_evidence.py`, `docs/WALLETS.md:57` |
| Circle Skills | **Consumer only** — plugin installed at user scope (`make skills-install`) | `Makefile:300` |
| Smart Contract Platform | **STUBBED** — dry-run code only; real deploys used Foundry | `scripts/deploy_circle.py` |
| CCTP / App Kits / UBK | **ABSENT, admitted** — UBK now promoted to core work (§4) | `CIRCLE-SESSION-QUESTIONS.md:717-720` |

**Verdict: the machinery is one product; the pitch is two.** Closable gaps, now rubric-ranked: (1) **App Kits via Unified Balance Kit** (named in the brief), (2) **published skill** (Agent Stack as contributor), (3) **receipts growth** (autonomous USDC-flow evidence). SCP/CCTP: honest non-claims.

### The six seams (from the pitch audit)

- **A.** Futures venue pitched as "roadmap week 6" in SUBMISSION.md §2. The unifying line — *"a benchmark is a number something settles against… settlement refuses a print older than two hours, so the feed has a dependent that breaks when the feed breaks"* — exists only at `CIRCLE-SESSION-QUESTIONS.md:730`, in neither SUBMISSION.md nor the deck.
- **B.** SUBMISSION.md §4 is a compliance table literally titled *"Circle Agent Stack coverage (all 5 pillars → code)"* — written for scoring, not for a user.
- **C.** The x402 buyer flow reads as a second product ("a data marketplace"). The joining sentence — *"the print it purchases is the input to the position it takes, and the log says so"* — exists only at `CIRCLE-SESSION-QUESTIONS.md:752`.
- **D.** `FeedAccessAttestor` (off-chain payment → on-chain right) is orphaned: absent from the deck, one parenthetical in §3.
- **E.** `/ops` is an operator product — fine, colophon-only, keep.
- **F.** Nav order vs judge path mismatch; Companion ("Start Here" in plain edition) is last.

---

## 3. WS1 — One-product narrative rewrite (Sat, docs only)

### `docs/SUBMISSION.md`
- **Kill roadmap-first §2** → appendix.
- **New §1 spine = the two promoted sentences** (`CIRCLE-SESSION-QUESTIONS.md:730` and `:752`). These ARE the product; everything else is cast.
- **Dissolve §4's pillar table into §2 "The economy of agents"** — one row per agent: **press** (dev-controlled EOA · pays gas to sign hourly prints · decides nothing, that's the point), **maker/taker** (dev-controlled EOAs · quote + heartbeat · keeper decides from chain state · venue tape), **hedger** (agent wallet; SCA `0x1Dc707E3…` trades / EOA `0x71e140d9…` pays · buys the print, sizes the gap to its 2.5 mandate · `data/hedger_decisions.jsonl`), **reader** (user-controlled SCA · PIN, Gas Station-sponsored · Public Desk), **CLI buyer** (`apps/agent` · pays 13 priced resources · receipts archive). Wallet type / what it pays / what it decides / where its log is — that IS pillar coverage, told as a story. Compact pillar→code table survives as judge-map appendix.
- **FeedAccessAttestor promoted** to its own paragraph: "off-chain payment becomes an on-chain right — the receipt is a contract-readable fact."
- **Roadmap/lifecycle close:** mainnet Sept 16 framing + marketplace listing status + the one $GPOOR roadmap line (§1).
- Preserve verbatim: "submitted, not listed" · "plumbing proven, demand not" · honesty tiers §6.

### `docs/presentation.md` deck
1. Slide 3 hedger → protagonist of an *economy*, trailing the cast list. 2. Pillar-coverage content → the cast slide. 3. Six-dependencies slide gains the FeedAccessAttestor bridge sentence. 4. **Penultimate slide = lifecycle close:** mainnet-day-one infrastructure + listing submitted + skill published + the $GPOOR roadmap one-liner (a smile, not a build). 5. "THE LIVE DEMO · 4 MINUTES" → 3. 6. Re-stamp slide 9 with re-measured numbers. `make deck`.

### 3-minute video beat sheet (record Sat vs production, press pre-warmed)
- 0:00–0:20 `/` hero, live rate: "machine commerce's SOFR — and the economy that pays for it."
- 0:20–1:05 `/attack`: the $8,000 wash attack buying ≤2.39% — the wow, given full room.
- 1:05–1:45 `/curve`: desk + "settlement refuses a print older than 2 hours."
- 1:45–2:35 `/exchange`: the hedger card — **two tables and the sentence between them. There is no log on screen; do not call it one.** Point at *1 · prints it bought*: Circle Gateway batch UUIDs its own wallet settled at $0.0001 each, and say the thing that makes them interesting — a Gateway settlement is off-chain, so no explorer resolves it, which is why the seller publishes a receipts tape at all. Read the joint line as written ("the venue fills every trade at that same print, so the position below is that print, priced"), then the arithmetic on screen. Then *2 · fills it took* — if it is empty, say why before anyone wonders: an agent that has reached its mandate stops trading, so its fills age out of the ~8h window while the position they built persists in contract state, and the card says exactly that in its own empty row. (Want fills on camera? Run the round-trip in `docs/SHIP-CHECKLIST.md` within ~8h of recording.) Close on one live buy click. **The line to land: decision logic tied to a real signal it paid for, and both legs are public state — one off-chain receipt, one on-chain position — not a file we are asking you to trust.**
- 2:35–3:00 honesty pill ("this ladder never fakes freshness"), lifecycle close, repo.

---

## 4. WS2 — Stack-closure code (all lands Fri, pre-freeze; rubric-ranked)

### (i) Unified Balance Kit deposit — PROMOTED to core (App Kits are named in the brief)
`apps/agent/src/deposit.ts` via `@circle-fin/unified-balance-kit` (no kit key; Arc testnet supported; viem private-key adapter over `AGENT_PRIVATE_KEY`) + Makefile target `make gateway-deposit`. Replaces the manual `make circle-deposit` operator step AND closes the admitted App Kits gap. Verify: run one real deposit, show Gateway `available` moving via `app/api/circle/balances`. If the SDK fights back >3h, stop and write the honest limitation line instead — do not let it eat the day.

### (ii) Publish the `acr-hedge` skill — consumer → contributor of the Agent Stack
`skills/acr-hedge/SKILL.md` (repo root, referenced from README + /developers): frontmatter with triggers, then the 4-step loop any Claude agent can run, commands lifted from working code: **discover** (`circle services search` / `GET /marketplace/catalog`) → **pay** (`circle services pay https://acr-api-1fto.onrender.com/prints/ACR-INF --address … --chain ARC-TESTNET --max-amount 0.0002`, + the `NODE_OPTIONS=--experimental-global-webcrypto` gotcha from `hedger.py:166-179`) → **read venue** (free futures endpoints) → **hedge** (`circle wallet execute "trade(uint256,int256)"` with the WAD warning from `_fmt_qty`, `hedger.py:243-249`). Cast-list line: "we consume Circle Skills and publish one back."

### (iii) Receipts growth — 11 → ≥30 by Sunday's capture
Ops (allowed post-freeze): agent buyer batches across ~8 of 13 priced resources × 2 sessions (~16) + `make hedger` ×4 + terminal `/api/buy` ×3 during click-throughs. `make x402-capture` folds them in; update the receipts sentence **same-commit** (verify-claims rule). Keep verbatim: *"plumbing proven, demand not"* — with a bigger tape behind it.

### (iv) Copy-level seam fixes (code, Fri)
- `/exchange` standfirst gains the joining sentence; plain variant: *"the same agent pays for the number, then trades on it — one wallet, one log."*
- **NAV reorder** (`components/Masthead.tsx:15-26`): `/companion` ("Start Here") from last to slot 2. One array edit, no coverage churn.

### (v) Rejected force-fits — one honest line each in SUBMISSION §8
- SCP: "Contract deploys used Foundry; `scripts/deploy_circle.py` remains a dry-run — we won't claim a platform we didn't ship through."
- CCTP/Bridge: "Single-chain by design; the benchmark's dependents live where it prints. CCTP is the multi-chain roadmap, not a claim."

---

## 5. WS3 — Truth pass + operations (Sat/Sun)

- **Truth pass (Sat, one commit, re-MEASURE on the frozen commit):** fix `docs/MVP_STATUS.md:105` ("11 suites") + `:183` (node count), `docs/IMPLEMENTATION_STATUS.md:170-172` (303/50/81 → measured), deck slide 9 date stamp. `make verify-claims` enforces same-commit.
- **O1** Timed Public Desk walkthrough on ACR-GPU vs production (Sat) — the "trading in under N minutes" number goes in the pitch.
- **O2** Marketplace listing re-check Sun AM; claim stays "submitted, not listed" unless Discovery shows otherwise.
- **O3** ACR-GPU book ~3.2 trades from freezing — **user funding call Fri AM** (faucet → treasury → `venue/collateralize`, ~1 USDC). Without it `VERIFY_STRICT=1 make verify-live` (ritual step 5) fails. **The single external dependency.**
- **O4** `ACR_OPS_TOKEN`: keep set; never on video.
- **O5** Record the submitted commit hash in SHIP-CHECKLIST step 10's blank.
- **Snapshot rule:** `make snapshot` runs with `ACR_HEDGER_ADDRESS` + `ACR_HEDGER_PAYER` **exported** — else the archive shows the hedger "not configured" (`gen_snapshot.py:186-211`, `hedger.py:63-64`). Add to ritual step 3 text (docs edit, Sat).
- **Deploy order:** Render (press) BEFORE Vercel (terminal) when `services/` changed. Render env gotchas: single-key PUT; `SKIP_BUILD=1` redeploy after any env change.
- **Sunday:** the 10-step ritual runs unmodified from 10:00.

---

## 6. Schedule, cut order, risks

### Day-by-day (IST)
**Thu 08-07 night:** narrative outlines (SUBMISSION/deck restructure notes) · flag the O3 funding call to user tonight · optional: skim UBK docs so Friday starts warm.
**Fri 08-08 (freeze EOD):** 09:00–12:00 UBK deposit script + one real deposit verified (3h stop-loss) · 12:00–14:00 `skills/acr-hedge/SKILL.md` + README//developers refs · 14:00–16:00 `/exchange` standfirst + NAV reorder + copy seams · 16:00–18:00 receipts session 1 + O3 collateralize (post-funding) + `make ci` + `verify-claims` · 18:00–19:30 deploy Render→Vercel + click-through both editions · **freeze: tag the commit.**
**Sat 08-09 (docs only):** SUBMISSION rewrite + truth pass + ritual-step-3 note (AM) · deck + `make deck` + O1 timed walkthrough (PM) · record + edit video, receipts session 2 (eve).
**Sun 08-10:** 10:00 warm press → ritual steps 1–10 → **submit ~15:30** → record hash. 15:30–17:29 buffer, deliberately empty.

### Cut order if Friday slips (top = first)
1. UBK (its stop-loss already bounds it) → 2. NAV reorder → 3. skill polish (ship minimal SKILL.md). **Never cut:** truth pass, SUBMISSION rewrite, video, ritual, receipts capture.

### Risk register
| Risk | Mitigation |
|---|---|
| UBK SDK fights on a deadline | 3h stop-loss → honest limitation line instead |
| Treasury can't fund O3 top-up | user faucet call Thu night/Fri AM — flagged now |
| Snapshot archives "not configured" hedger | env-export rule added to ritual step 3; checked in snapshot diff |
| Render env not live after PUT | `SKIP_BUILD=1` redeploy, in the plan twice deliberately |
| Test counts drift after Friday's code | truth pass re-measures on the frozen commit, same-commit rule |
| Press asleep during video/judging | warm first, always |
| Marketplace still unlisted at submit | claim stays "submitted, not listed" — already the documented posture |

---

## 7. Verification

1. **Gates green on the frozen commit:** `make ci` 4/4 · `make verify-claims` · `VERIFY_STRICT=1 make verify-live` (contingent on O3 funding).
2. **UBK:** one real Gateway deposit visible in `app/api/circle/balances` output; `make gateway-deposit` documented.
3. **Production click-through both editions** after Render→Vercel deploy; snapshot diff shows the hedger configured.
4. **Sunday ritual steps 1–10** gate the submission; receipts ≥30 in the same capture; every link clicked once; hash recorded.

### Critical files
`scripts/hedger.py` · `apps/agent/src/` (UBK deposit home) · `services/index_api/index_api/hedger.py` · `apps/terminal/components/Masthead.tsx` · `apps/terminal/lib/coverage.test.ts` · `scripts/gen_snapshot.py` · `docs/SUBMISSION.md` + `docs/presentation.md` · `docs/SHIP-CHECKLIST.md`.

---

## Appendix — $GPOOR launch playbook (ONLY if user overrides the verdict; not scheduled)

Frame: **$GPOOR ("GPU Poor"), mined by Proof of Whine** — agents file on-chain complaints about compute prices quoting the live ACR print; closer "Stop whining. Hedge." Mechanics: ACTFUN `LaunchpadFactory` v3 `0x6b383a533DA4AAaec71d85D8e8E5bf5A2E254f2C` (Arc Testnet 5042002); permissionless `createToken`; 6 immutable params; 1-hour window; miners pay `feePerMine` (native USDC wei) per post; graduation → 5% supply + all fees become permanent x·y=k AMM liquidity; refunds on failure. Execution: recon ABI via arcscan or tx-input decoding; derive params from a prior GRADUATED launch (`getTokens`/`launcherByToken`); rehearse with a throwaway ("DRYRUN1") first; mine with 6 raw-key EOAs via `LocalKeySigner` (NOT Circle wallets — `contract_execution` has no native-value param; `mine()` is payable); size `mineAmount = maxSupply/40` → ~35 min to graduate with 25 min slack; total cost ≈ 0.4 USDC + funding. Evidence: whine tape JSONL + arcscan links + graduation tx + one post-graduation swap. Fallback: refunds → retry → ship the failure honestly → cut. Post-hackathon, this becomes the community launch the roadmap line promises — run it when real miners exist.
