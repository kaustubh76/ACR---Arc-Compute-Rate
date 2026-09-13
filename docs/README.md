# ACR documentation — an index

This directory was written over seven weeks, at different times and for different
readers. This page says which ones to read, in what order, and — just as usefully —
which ones are a build record rather than a description of the product.

**Every Markdown file in this directory is listed somewhere below.** That is an
invariant rather than a count, because a count rots and nothing in CI was gating
this one — six docs had quietly fallen out of this index before anyone noticed.
Check it with:

```bash
for f in docs/*.md; do b=$(basename "$f"); [ "$b" = README.md ] && continue
  grep -q "$b" docs/README.md || echo "unlisted: $b"; done
```

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
| [MAINNET_RUNBOOK.md](MAINNET_RUNBOOK.md) | Arc mainnet (`eip155:5042`, genesis 2026-09-16): the same five deploys in order, `make deploy-mainnet-dry` with a chain-id preflight, and what to set after each address exists. Deployment-ready, stated as such |
| [DEPLOY.md](DEPLOY.md) | The cloud deployment runbook — Render (API) + Vercel (Terminal) |
| [GRAPH-RUNBOOK.md](GRAPH-RUNBOOK.md) | The five ordered steps to bring the `acr-tape` subgraph up on Studio. Two of them are **not recoverable if done out of order** |
| [acr-openapi.md](acr-openapi.md) · [.pdf](acr-openapi.pdf) | The seller API's endpoint reference, rendered from the live OpenAPI 3.1 schema |

## Module designs — the decisions, taken before the code

Each of these settles a design whose mistakes would be expensive or permanent, and
states the limits it is accepting rather than leaving them to be discovered.

| Doc | What it settles |
|---|---|
| [WORLD-MODULE.md](WORLD-MODULE.md) | Module W — World ID / AgentKit: what goes on chain (never a raw nullifier), the rotation period, and the two decisions that cannot be taken back. Written before the module existed; `HumanIdMirror` has since shipped, so read it as the design record |
| [AGENT-MODULE.md](AGENT-MODULE.md) | Module A — the agent card, the gate, and a rate limit denominated in **people** rather than keys. Why the EIP-712 domain deliberately names no `verifyingContract`, and why the carded tier is evadable on purpose |

---

## Pitch material

| Doc | Covers |
|---|---|
| [PITCH.md](PITCH.md) | What to say over the eight slides — the spoken argument, what *not* to say, and the four questions a judge will ask |
| [SUBMISSION-BRIEF.md](SUBMISSION-BRIEF.md) · [.pdf](submission-brief.pdf) | The final submission brief: nine sections, one per required item |
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
| [SPIKE-LOG.md](SPIKE-LOG.md) | Measurements of The Graph on Arc, each with the command that produced it. Figures that later stopped being true stay, marked, rather than being quietly corrected |

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
