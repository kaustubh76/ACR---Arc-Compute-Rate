# ACR — Implementation

This repository implements the ACR blueprint (`Readme.md` + `acr_architecture.excalidraw`)
as a working, tested system: a calibrated payment-exhaust simulator, the
four-pillar estimator, on-chain contracts, a cash-settled instrument, an
x402-gated index API, and a live Terminal with the "Attack the Index" demo.

## Quickstart

```bash
make setup        # uv sync --all-packages · forge install · npm install
make test         # python (pytest) + contracts (forge test)
make pipeline     # estimator on simulated exhaust → live ACR prints
make demo         # the 5-step "Attack the Index" demo
make eval         # ACR-vs-VWAP error series (the judge chart)
make api          # x402-gated index API on :8000
make terminal     # ACR Terminal on :3000
make anvil        # local chain :8545  (then, in another shell:)
make onchain      # deploy → post signed prints → read back → settle future (⑧⑨)
```

Prereqs: Python ≥3.11 + [uv], [Foundry] (`forge`), Node ≥18 + npm.

## Layout → blueprint zones

| Path | Zone | What it is |
|---|---|---|
| `packages/acr_core` | — | Shared types (`TapeEvent`, `SellerAttestation`, `ACRPrint`), index registry, config (incl. deterministic USDC fees), math primitives (weighted median, α-trim, volume-time bars). |
| `packages/acr_sim` | A | Calibrated simulator: OU latent, seller quality premia, **Gateway batching operator**, wash-flow adversary + ground truth. |
| `packages/acr_tape` | A | `TapeSource` interface → `SimSource` (today) + `ArcSource` (Arc testnet RPC, tolerant of thin data). |
| `packages/acr_estimator` | B | **The product.** Indexer → observation model (Pillar 1, Kalman deconvolution) → cleaning (Louvain sybil) → robust trimmed weighted median + CI → hedonic (Pillar 2) → manipulation bound (Pillar 3) → `ACRPrint`. |
| `contracts/` | C | `AttestationRegistry.sol`, `ACROracle.sol`, unit + **invariant** suites (monotone ts, print∈CI, bound sanity). |
| `packages/acr_instrument` | D | Pillar 4: cash-settled `ACRFuture` + Avellaneda–Stoikov market maker. |
| `packages/acr_oracle_client` | C | EIP-712-sign a print (domain `ACR Oracle`) + relay `postPrint`; the contract verifies the signer, so any relayer may post (offline-tolerant). |
| `services/index_api` | E | FastAPI, **x402-gated** endpoints + oracle-poster job + Terminal data. |
| `apps/terminal` | E | Next.js Terminal: prints, term structure, seller scores, **Attack the Index** view. |
| `redteam/` + `scripts/` | red | Wash-flow attack, `run_demo.py`, `eval.py`, `run_pipeline.py`, `gen_snapshot.py`. |
| `docs/methodology.md` | roadmap | The methodology paper — the Week-2 OSS deliverable. |

## What it demonstrates

- **Flow ①–⑩** of the blueprint runs end to end on simulated Arc exhaust.
- Under the paired demo attack ($8k budget), **naive VWAP is dragged >100%**
  (measured 107–123%) while **ACR moves <3%** (measured 0.2–2.4%) — 50–560×
  more resistant; over the 12-hour eval series the attack-window VWAP error is
  **~57%** vs ACR **~1.2%** (~46×). These numbers are **CI-gated**
  (`make eval-gate`, `tests/test_claims.py`) so they can't drift — see `make demo`.
- Every print carries a **confidence interval**, an **attack-cost bound** (with the
  sybil clusters/identities it implies), and per-print **robustness diagnostics**;
  `ACROracle` verifies an **EIP-712 signature** and enforces the invariants on-chain
  (`forge test`, 100% passing).
- The **full on-chain round trip runs against a local anvil** (`make onchain`):
  contracts deploy, sellers **attest metadata on-chain and it reads back** (the
  hedonic flywheel), prints post + read back byte-identical, and an ACR-Weekly
  future cash-settles against the on-chain value.
- With `ACR_ORACLE_ADDRESS` set, the API serves the **settlement-grade on-chain
  print** at `GET /onchain/{index_id}`, and the Terminal shows a "⛓ on-chain ✓"
  provenance badge. `ArcSource.attestations()` reads the registry via
  `RegistryClient`, so the estimator's feature matrix can come from chain.
- The same estimator runs on `SimSource` today and `ArcSource` (real testnet)
  unchanged.

## Status / notes

- Data source is simulator-first with a real Arc-testnet adapter behind the same
  `TapeSource` interface; set `ACR_TAPE_SOURCE=arc` (+ `ACR_ARC_RPC_URL`) to serve
  the live tape. `ArcSource` decodes the on-chain USDC `Transfer` at the Arc USDC
  system contract (`0x3600…0000`); `size`/`service` aren't on-chain, so the
  authoritative tape is the facilitator's own settlement log.
- The API refreshes on a timer (`ACR_REFRESH_SECONDS`, default 30s) so prints
  actually evolve and realized vol becomes real. Signing is via a `Signer`: a raw
  key (`ACR_POSTER_PRIVATE_KEY`, dev) **or** a Circle developer-controlled wallet
  (`ACR_CIRCLE_*`, prod) that EIP-712-signs each print — the oracle verifies the
  *signer*, so any relayer submits and the key stays in Circle custody.
- `ACROracle` is brick-proofed (timestamp-skew bound), pausable, and uses two-step
  ownership; `AttestationRegistry` uses nonces + deadlines against signature replay.
- CI (`.github/workflows/ci.yml`, `make ci`) runs ruff, pytest, `forge test`, and
  the eval gate on every push.
- **Live Circle/Arc wiring** (see `.env.example`): the x402 gate is a `Facilitator`
  — `DevFacilitator` (mock header) by default, or the real `CircleFacilitator`
  (x402 v2: `PAYMENT-REQUIRED` → Circle Gateway `/verify` + `/settle`, `exact`
  scheme over EIP-3009) when `ACR_X402_FACILITATOR_URL` + `ACR_X402_PAY_TO` are
  set. `scripts/deploy_circle.py` deploys the contracts via Circle's Smart
  Contract Platform. Arc chain id is `5042002` and USDC is the native gas token,
  so gasless is intrinsic — no ERC-4337 paymaster needed. Everything stays
  offline-tolerant: with no creds, `make test` runs credential-free.
- The Terminal pins Next `14.2.x`; upgrade to Next 15 to clear the Dec-2025
  advisory before any public deployment.

See `docs/methodology.md` for the estimator specification and `Readme.md` for the
architectural blueprint.

[uv]: https://docs.astral.sh/uv/
[Foundry]: https://book.getfoundry.sh/
