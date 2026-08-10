# ACR documentation — an index

This directory holds twenty files written over seven weeks, at different times and for
different readers. This page says which ones to read, in what order, and — just as
usefully — which ones are a build record rather than a description of the product.

New here? The [root README](../README.md) is the shortest complete answer to
*what is ACR*. Then come back for depth.

---

## Read these five

| Doc | Why |
|---|---|
| **[SUBMISSION.md](SUBMISSION.md)** | **Start here.** The judge-facing status page: what is live, the evidence for each claim, the honesty tiers (`sim` / `gateway-ref` / `tx`) that separate a real transaction from a simulated one, and the known limitations. If you read one file, read this. |
| **[methodology.md](methodology.md)** | The methodology paper — the estimand, the estimator, and the manipulation bound. This is the actual product; the software is its implementation. |
| **[ARCHITECTURE-DIAGRAM.md](ARCHITECTURE-DIAGRAM.md)** | The architecture canvas (`acr_architecture.excalidraw`) explained zone by zone, plus the ①–⑩ data flow and the product reasoning behind it. |
| **[GLOSSARY.md](GLOSSARY.md)** | Every technical term in plain English with everyday analogies. Rendered live at [`/companion`](https://arc-compute-rate.vercel.app/companion). |
| **[WALLETS.md](WALLETS.md)** | Which of Circle's four wallet products does which job here, and the constraint that forces each choice. The most reusable document in the repo. |

---

## Runbooks — how to operate it

| Doc | Covers |
|---|---|
| [agent-runbook.md](agent-runbook.md) | The live Circle Agent Stack loop: the buyer agent discovers listings, pays x402 nanopayments, and receipts print on `/exchange` |
| [TESTNET_RUNBOOK.md](TESTNET_RUNBOOK.md) | The ordered `[OPERATOR]` / `[AUTOMATED]` sequence to bring the whole system up on Arc testnet |
| [DEPLOY.md](DEPLOY.md) | The cloud deployment runbook — Render (API) + Vercel (Terminal) |
| [acr-openapi.md](acr-openapi.md) · [.pdf](acr-openapi.pdf) | The seller API's endpoint reference, rendered from the live OpenAPI 3.1 schema |

## Pitch material

| Doc | Covers |
|---|---|
| [presentation.md](presentation.md) · [.html](presentation.html) · [.pdf](presentation.pdf) | The pitch deck (Marp). `make deck` re-renders the HTML and PDF from the Markdown |
| [DEMO-SCRIPT.md](DEMO-SCRIPT.md) | The 3-minute submission-video script, screen-by-screen |

---

## Build record — context, not description

These are honest artifacts of how the project was built. They are kept because they
show the reasoning, including the wrong turns. **They are not maintained as
descriptions of the current system** — where they disagree with `SUBMISSION.md`,
`SUBMISSION.md` is right.

| Doc | What it is |
|---|---|
| [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) | The long-form build status: what exists, what is real vs. simulated, and where to look |
| [MVP_STATUS.md](MVP_STATUS.md) | MVP completeness and gap analysis, snapshot dated 2026-08-05 |
| [SHIP-CHECKLIST.md](SHIP-CHECKLIST.md) | The deadline tracker for submission week |
| [ENDGAME-PLAN.md](ENDGAME-PLAN.md) | The final-week execution plan. Self-labelled at the top: *this plan was executed; it is a record now, not an instruction sheet* |
| [CONTEXT_LOG.md](CONTEXT_LOG.md) | A deep working log, written so the reasoning survives past any one session's memory |

Two more build-record files live at the repo root: `MARKETPLACE-LISTING.md` (the
Circle Agent Marketplace submission, plus the measurement that its Discovery API
carries 958 listings and none on Arc testnet) and `CIRCLE-SESSION-QUESTIONS.md`
(whose second half is the hostile-Q&A defense document — the most substantive
thing in either file).

---

## A note on numbers

Several of these documents quote measured figures — suite sizes, receipt counts,
deployed addresses. Those are **gated in CI** by
[`scripts/verify_claims.py`](../scripts/verify_claims.py), which re-measures them on
every push and fails the build when a document and reality disagree. It exists
because five such numbers had quietly rotted in a project whose entire argument is
that its claims are true.

Run it yourself:

```bash
uv run python scripts/verify_claims.py
```
