# ACR documentation — an index

Twelve documents, three groups: what the number *is*, how to *use* it, how to *run* it.
Read the root [README](../README.md) first — it is the shortest complete answer to
*what is ACR* — then come here for depth.

**Every Markdown file in this directory is listed below.** That is an invariant rather
than a count, because a count rots. Check it with:

```bash
for f in docs/*.md; do b=$(basename "$f"); [ "$b" = README.md ] && continue
  grep -q "$b" docs/README.md || echo "unlisted: $b"; done
```

---

## Start here — what the number is

| Doc | Why |
|---|---|
| **[methodology.md](methodology.md)** | The methodology paper — the estimand, the estimator, and the manipulation bound. This is the product; the software is its implementation. |
| **[ARCHITECTURE-DIAGRAM.md](ARCHITECTURE-DIAGRAM.md)** | The architecture canvas (`acr_architecture.excalidraw`) explained zone by zone, with the ①–⑩ data flow and the product reasoning behind it. |
| **[GLOSSARY.md](GLOSSARY.md)** | Every technical term in plain English with an everyday analogy. Rendered live at [`/companion`](https://arc-compute-rate.vercel.app/companion), and gated in CI against the canvas so no term goes undefined. |

## Use it — as an agent, a buyer, or a builder

| Doc | Covers |
|---|---|
| [acr-openapi.md](acr-openapi.md) | The seller API, endpoint by endpoint, rendered from the live OpenAPI 3.1 schema (`make openapi-doc-check` fails when stale). Mirrored at [`/developers`](https://arc-compute-rate.vercel.app/developers). |
| [agent-runbook.md](agent-runbook.md) | The Circle Agent Stack loop end to end: the buyer discovers listings, pays x402 nanopayments, reads its own transaction costs and reroutes. |
| [AGENT-MODULE.md](AGENT-MODULE.md) | The agent card, the gate, and a rate limit denominated in **people** rather than keys — why the EIP-712 domain names no `verifyingContract`, and why the carded tier is evadable on purpose. |
| [WALLETS.md](WALLETS.md) | Which of Circle's wallet products does which job here, and the constraint that forced each choice. The most reusable document in the repo. |

## Run it — operating the system

| Doc | Covers |
|---|---|
| [TESTNET_RUNBOOK.md](TESTNET_RUNBOOK.md) | The ordered `[OPERATOR]` / `[AUTOMATED]` sequence to bring the whole system up on Arc testnet. |
| [MAINNET_RUNBOOK.md](MAINNET_RUNBOOK.md) | Arc mainnet (`eip155:5042`): the same five deploys in order, `make deploy-mainnet-dry` with a chain-id preflight, and what to set after each address exists. |
| [DEPLOY.md](DEPLOY.md) | The cloud pair — Render (API) and Vercel (Terminal). Merging does not deploy the API: Render pulls a prebuilt image. |
| [GRAPH-RUNBOOK.md](GRAPH-RUNBOOK.md) | The five ordered steps to bring the `acr-tape` subgraph up on Studio. Two of them are **not recoverable if done out of order**. |

---

## A note on numbers

The root README quotes measured figures — suite sizes, the glossary, the receipts
archive, the CI shape, the deployed addresses. They are **gated in CI** by
[`scripts/verify_claims.py`](../scripts/verify_claims.py), which re-measures each one on
every push and fails the build when the README and reality disagree. It exists because
numbers written into prose rot silently, in a project whose whole argument is that its
claims are true.

```bash
uv run python scripts/verify_claims.py
```

## Where the rest went

ACR began as two hackathon submissions. Their pitch decks, status pages, design records
and sponsor feedback are preserved — unmaintained — under [`../hackathon/`](../hackathon/),
with a README that says what each folder was and which tag freezes it.
