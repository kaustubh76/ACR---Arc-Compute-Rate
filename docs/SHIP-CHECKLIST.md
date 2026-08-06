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
   archive (`services/index_api/index_api/receipts_live.jsonl`). If the count
   moved, update the "11 Gateway-settled receipts" sentence in
   `SUBMISSION.md` **in the same commit**.
3. `make snapshot` → `git diff apps/terminal/lib/fallback.json` (sane = fresh
   prints, a full trade tape, live open interest on all three books) → stage.
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
