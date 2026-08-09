# SHIP-CHECKLIST — submission 2026-08-10

The one file that tracks the deadline. Everything here is either a gate that
must exit 0 on the submitted commit, or a click a judge will make within the
first two minutes. The evidence rules stay the rules: **no number changes
without its re-measurement in the same commit** (`make verify-claims` enforces
this in CI), and `make snapshot` rewrites a committed file — diff before
staging.

## Standing facts

- **Deadline:** 2026-08-10. Code freeze EOD 2026-08-08; 08-09 is docs/deck
  only; 08-10 is the ritual below, not a workday.
- **Deploys are manual, both hosts.** Terminal: `npx vercel --prod` from
  `apps/terminal`. Press: `deploy/redeploy-render.sh` (Docker image). A pushed
  commit changes neither production surface by itself.
- **The press sleeps** (Render free tier). Never verify, demo, or snapshot
  against a cold press — warm it first and wait for `/health` to answer.
- The keepalive cron is real but lossy (GitHub fires a fraction of its slots);
  liveness rides on the press's in-process keeper + self-ping. The measured
  proof is in `SUBMISSION.md` §5 — re-confirm it in step 6 rather than
  re-asserting it. **Re-measured 2026-08-06: 37.2 h, 48 runs, median 60.3 min,
  max 153.3 — ONE breach of the settle window** (08-05 18:38 → 21:11). The
  08-05 reading (18.8 h, max 60.6, zero breaches) was true when taken; the miss
  came after it. Do not re-scope the window to hide it — `/ops` now reports
  this continuously, so a judge can see the same number we do.

## The judge's first two minutes (rehearse this path)

`/` (hero, live flagship rate; **two** CTAs since 08-06 — "Watch the attack"
and "Open the desk", the second deep-linking to `/curve#desk`) → `/attack`
(the money demo) → `/curve` (desk + Public Desk visible, with the five-step
rail showing where a reader is; on a cold press the desk states its wake with
a live countdown and opens itself) → `/exchange` (live buyer button, **no**
env-var copy visible) → `/sellers` → `/developers` → `/companion` (in the nav
since 08-05; the plain edition calls it **Start Here**) → `/ops` (the systems
ledger, linked from the colophon, not the nav). Toggle both editions at least
once.

## The systems ledger and the operator console (added 08-06)

`/ops` serves `GET /ops/verify` — the press checking itself on a 15-minute
timer (`ACR_OPS_VERIFY_S`), eight sections read off the caches the warm loop
already keeps hot. It is **not** a replacement for `make verify-live`, which
still probes the deployment from OUTSIDE over the public internet and is the
only thing that can catch a Vercel route or a dropped cron. Both matter; the
page says so.

The ledger has **no archived fallback on purpose**. Every other surface falls
back to the bundle because an old print is still a true print; an old *verdict*
is a lie, because it asserts the health of a service that is not answering.
A cold press renders "no verdict", never a stored green.

Below it, the operator console (`POST /ops/actions`) exposes the money-moving
Makefile targets — settle, roll, collateral top-up, treasury transfer, pause,
plus keeper nudges and a forced re-verify.

- **Off unless `ACR_OPS_TOKEN` is set** on the press. Unset → the routes 404
  (not 401): an endpoint that admits it exists is one worth guessing at.
  **Decide before submission whether to set it in production at all** — the
  read-only ledger stands on its own without it.
- **Dry-run is the default.** Executing needs an explicit `dry_run: false`,
  and the UI disables the run button until a dry run for that exact form has
  returned; editing any field clears it.
- Caps bind server-side regardless of what the UI sends: collateral
  `COLLATERALIZE_MAX_USDC` (2.0), transfers `OPS_MAX_FUND_USDC` (5.0), and the
  faucet-reserve guard ported from `scripts/fund_role.py` — a transfer that
  would leave the drip unable to pay the next readers' stakes is **refused,
  not clamped**.
- Every attempt, including refusals, appends to `data/ops_actions.jsonl` and
  is served back in the console. The disk is ephemeral on Render, which is why
  the trail is shown in-session rather than only written.
- Deliberately absent: `setSigner`, `transferOwnership`, `openSeries` (the
  roll covers it) and contract deploys. Those change who controls the system
  rather than what it is doing, and a bearer token is not the right key.
- The key lives in `sessionStorage` only — it dies with the tab, is never
  logged, and never travels in a URL.

Expiries: series 3 (ACR-INF) settles 2026-08-17, series 4/5 (GPU/DATA)
2026-08-18 — all after the deadline; no roll should occur before submission.
If one somehow does, `make snapshot` again (step 3) or the archive names a
dead series.

## Submission-morning ritual (~45 min, ordered; each step gates the next)

1. **Warm the press.** `curl https://acr-api-1fto.onrender.com/health` — wait
   for `3` live indices, gate `circle`, signer `circle`; the post-on-wake
   catch-up lands a fresh print if the box overslept.
2. `make x402-capture` — fold any new Gateway settlements into the durable
   archive (`services/index_api/index_api/receipts_live.jsonl`), then `wc -l`
   it. If the count moved, update **every** doc that states it, in the same
   commit — and search for the **number**, not for a sentence:
   - `docs/SUBMISSION.md` §4 — the receipts count and the payer split
   - `Readme.md` Zone H — "real Gateway x402 settlements"
   - `docs/IMPLEMENTATION_STATUS.md` TL;DR — "`receipts_live.jsonl`, N rows"
   - `docs/ENDGAME-PLAN.md` §2 — the Nanopayments row
   - `docs/agent-runbook.md` §4 — the durable-proof sentence

   This step used to name a phrase ("the 11 Gateway-settled receipts sentence")
   that stopped existing the instant the count moved, so the ritual could only
   find its target on the runs where there was nothing to do. `make
   verify-claims` now measures the archive and fails if any of these disagree,
   so a miss here is caught rather than shipped.
3. `make snapshot` — nothing to export. The two hedger addresses now resolve
   from `.env` as well as from the process environment (`ACRSettings`), and
   `check_hedger_commit_guard` **refuses to write the bundle** if the agent,
   its payer, its position or its receipts would be missing. This step used to
   read "remember to export them first", and the reason it is written this way
   now is that the ritual was forgotten once and the archive shipped an agent
   reporting itself as "not configured" — the offline demo losing its
   protagonist, silently, past a green CI. The run prints
   `hedger=set (N receipts)`; if it says `NULL` the guard has already stopped
   you. Then `git diff apps/terminal/lib/fallback.json` (sane = fresh prints, a
   full trade tape, live open interest on all three books, **and a configured
   hedger carrying its own receipts**) → stage.
4. `make verify-claims` (full, **not** `CLAIMS_FAST`) → must exit 0.
5. `VERIFY_STRICT=1 make verify-live` → must exit 0.
6. `GAP_PAGES=24 make print-gaps` → the recorded tail claim still holds; if
   the figures moved, update the §5 row with the new verbatim numbers.
7. Only if steps 2–6 changed a quoted number: bump the §5 evidence date and
   `make deck` (commit `presentation.md` + `.html` + `.pdf` together — the
   rendered artifacts otherwise keep the old date). If nothing moved, the
   existing evidence date stands and is honest.
8. Commit, push. GitHub Actions **4/4 green**. Then deploy what changed:
   terminal → `npx vercel --prod`; press only if server code changed.
9. Production click-through of the judge path above, both editions, desk
   visible on `/curve`.
10. Submit. Record the submitted commit hash here: `____________`

### Settled rounds are visible now (no pre-demo step needed)

`/curve` carries a **settled rounds** ledger under the desk table, built from
the roster's `settled` list at both live tiers. It reads three completed
ACR-INF rounds: #0 (1 Aug), and #1 and #2, both settled 9 Aug against a
17-minute-old print. Nothing has to be staged before recording — unlike the
hedger fill below, this state is permanent.

If an expired series is ever left unsettled again, `make futures-settle`
rings the bell (permissionless; it refuses safely when the print is over two
hours old). Do **not** run `make futures-withdraw` to "clean up" afterwards:
it targets the live series, so it drains book depth rather than reclaiming
anything from a settled round.

### The video records from `docs/DEMO-SCRIPT.md`

The full 3-minute script lives there: pre-flight (including the T-8h fills
decision below), six beats with verbatim narration harvested against the
production DOM, and the edit rules. Do not improvise the beats from memory.

### Putting a fresh fill on the hedger panel (before the video, and at step 9)

The panel's fills table is fed by a tape that walks back **~8h**
(`TAPE_PAGES=4` × `TAPE_PAGE_BLOCKS=14000` at Arc's 0.510s block time,
`packages/acr_oracle_client/acr_oracle_client/futures.py:73,84`). Older fills
are real and on-chain but invisible here — the copy says so rather than
claiming the agent never traded, and the position is the durable witness. If
you want fills **on screen** while someone is watching, they must be less than
~8h old.

A bare `make hedger` will not produce one: inside `MIN_TRADE = 0.25` of its
mandate the agent holds (`scripts/hedger.py`). It still pays 0.0001 for the
print, because `buy_the_print()` runs before the position read — a hold-run
raises the paid-queries count and adds no fill.

**There is no round-trip. Raise the mandate; you cannot lower it back.**

This checklist used to prescribe `HEDGER_TARGET=2.5` then `HEDGER_TARGET=2.0`
to buy a fill and sell it back. The second leg does not work, and the reason is
worth knowing before you plan a recording around it: **`circle wallet execute`
cannot build a transaction carrying a negative `int256`.** Measured 2026-08-08
on ARC-TESTNET — `+1e16` estimates and returns a fee, `-1e16` fails with
`400 Fails to perform transaction estimation`, and so do both two's-complement
spellings and a `--` separator. It is not a venue revert: the identical call
succeeds under `eth_call`, and an oversized *positive* quantity returns the
different error `Estimate fee execution reverted`, which is what a revert looks
like. So the agent can open and increase a position and cannot reduce one.

To put a fill on screen, raise the mandate by at least `MIN_TRADE` and leave it
raised:

```sh
HEDGER_TARGET=3.0 make hedger   # buys toward 3.0 — margin-capped by TOPUP_MAX_USDC
```

Then set `HEDGER_TARGET` to the position it actually reached, in **both**
`scripts/hedger.py` and `services/index_api/index_api/hedger.py` (a test pins
them together) and in `render.yaml`, so the panel reads "on target" rather than
showing a gap the agent has no way to close. Cost: ~0.50 USDC **posted as
collateral** — it stays in the venue and is withdrawable, it is not spent, and
it is not covered by `SPEND_CAP_USDC`, which governs only the x402 print — plus
0.0001 per run. Mind `POSITION_CAP = 3.0`: a mandate above it makes the agent
refuse rather than trade.

## Deployed 2026-08-06

PR #18 merged to `main` (`ca32650`) and **both surfaces shipped**, press first —
the diff touched `services/` as well as the terminal, so a terminal-only deploy
would have published an `/ops` page whose proxy 404s upstream.

- **Press** — `deploy/redeploy-render.sh`, image tag `2026-08-06-1105`, deploy
  `dep-d9q701u7bikc738jke70`. `/health` now carries `keeper` and
  `attestor_address`; `/ops/verify` and `/ops/actions` are live.
- **Terminal** — `npx vercel --prod`. `/ops` was a 404 in production before
  this and is now 200.
- **Two env vars were set on Render** (single-key PUT, so none of the other 28
  were touched): `ACR_OPS_TOKEN` (generated `openssl rand -hex 32` — hex, not
  base64: the terminal proxy's charset rejects `+/=`) and
  `ACR_ATTESTOR_ADDRESS`, which was only ever in the local `.env`, so
  production reported the fourth contract as absent until now.
  **A Render env change does not restart the service** — it needed a second
  `SKIP_BUILD=1 ./deploy/redeploy-render.sh` before the values took.

Verified against the deployed product: all 8 routes 200; `/ops/actions` 401
without a token and 200 with it; `venue/pause` **dry run** names the maker
wallet and matches the on-chain owner; `make interop` **12/12**;
`make verify-live` **ALL PILLARS LIVE**.

**Open, and a funding call rather than a code one:** `VERIFY_STRICT=1` still
fails on ACR-GPU book depth (~3.2 reader trades from freezing). The console can
deepen it — `venue/collateralize` dry-runs cleanly — but the maker sits at
2.516 USDC against its own 2.50 floor, so topping the book up starves the next
roll. It needs money from outside, not a command.

## Open items being tracked to the deadline

- [x] **INF top-up — DONE 2026-08-05** (operator, 0.07 USDC, tx
      `0x96d10f56…`, all witnesses agreeing): headroom 2.00 both sides, and
      `VERIFY_STRICT=1 make verify-live` now exits 0 — **ALL PILLARS LIVE**,
      recorded in `SUBMISSION.md` §5.
- [x] **Desk E2E re-proof — DONE 2026-08-05 against production**, on the
      ACR-GPU book: long 2.00 @ 0.01083 (`0x40e0c510…`), withdraw confirmed,
      `make desk-evidence` → CONFIRMED ON-CHAIN with Gas Station sponsorship.
      Found and fixed a judge-facing resume bug on small books along the way
      (`48aed53`); full account in `TESTNET_RUNBOOK.md` §2026-08-05.
- [ ] **Public Desk browser walkthrough** on ACR-GPU against production —
      PIN ceremony and all; time it (the "trading in under N minutes" number
      belongs in the pitch).
- [ ] Circle Marketplace listing: form submitted 2026-08-04; awaiting reply.
      The claim everywhere stays *submitted*, not *listed*.
- **Deliberately not doing:** revoking the deploy EOA's `ACROracle`
  signer/ownership (operator decision — documented honestly in
  `SUBMISSION.md` §on-chain and `CIRCLE-SESSION-QUESTIONS.md` §H); Next.js 15
  upgrade; cap-denominator refinement; x402-receipt tape audit.

Related: [`TESTNET_RUNBOOK.md`](TESTNET_RUNBOOK.md) for every command's
long-form runbook; [`SUBMISSION.md`](SUBMISSION.md) is the judge one-pager
this checklist exists to keep true.
