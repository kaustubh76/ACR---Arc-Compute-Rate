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
  proof (18.8 h, max gap 60.6 min, 0 settle-window breaches) is in
  `SUBMISSION.md` §5 — re-confirm it in step 6 rather than re-asserting it.

## The judge's first two minutes (rehearse this path)

`/` (hero, live flagship rate) → `/attack` (the money demo) → `/curve`
(desk + Public Desk visible; on a cold press the desk states its ~60s wake and
opens itself) → `/exchange` (live buyer button, **no** env-var copy visible) →
`/sellers` → `/developers` → `/companion` (in the nav since 08-05; the plain
edition calls it **Start Here**). Toggle both editions at least once.

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

- [ ] **INF top-up (operator, real USDC):** `COLLATERALIZE_DRY_RUN=0
      COLLATERALIZE_INDEX=ACR-INF uv run python scripts/futures_collateralize.py`
      — 0.04 USDC clears the one remaining `VERIFY_STRICT` failure
      (headroom 1.96 → 2.00).
- [ ] **Desk E2E re-proof (operator green-light, burns one 0.50 drip):**
      `make desk-preflight` → `make desk-e2e PLAYWRIGHT_DIR=…` →
      `make desk-evidence` — first clean run since the milestone predicate
      began asserting on the SCA address instead of page copy.
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
