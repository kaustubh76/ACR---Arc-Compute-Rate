# `acr-tape` — the subgraph that makes TCA a number

The Graph is **load-bearing** here, not a mirror of an API: every settlement an agent
makes on Arc is benchmarked *in the mapping*, at the moment it arrives, against the
ACR print it could have seen — and that `slippageBp` is the only input transaction-cost
analysis, seller ratings and the reroute decision have. Nothing downstream recomputes
it; nothing can disagree with it.

| | |
|---|---|
| **Studio** | account `1758707` · slug `ethonline` · **v0.2.0** · `QmdsGieTC7B4KTyd2pEhV1wmFLCeF1yCYwLLgBXL2a9Ci6` |
| **Endpoint (development)** | `https://api.studio.thegraph.com/query/1758707/ethonline/v0.2.0` — 3,000 queries/day, not counted on any dashboard |
| **Endpoint (production)** | `https://gateway.thegraph.com/api/subgraphs/id/<deployment id>` with an API key, after publishing — counted on the key's usage page (`docs/GRAPH-RUNBOOK.md` step 6) |
| **Network** | `arc-testnet` (`eip155:5042002`); `arc` mainnet is a Studio target too (`docs/MAINNET_RUNBOOK.md`) |
| **Lag, measured** | ~6 blocks / ~3 s behind Arc's head (2026-09-13), `hasIndexingErrors: false` |
| **Substreams** | **N/A** — Arc is a Studio-only ("basic" support) network; there is no Substreams endpoint to target, so that challenge is not attempted |

## Seven data sources, one tape

`subgraph.yaml` indexes **ACROracle** (v1, `0x4f00…2609`), **ACROracleV2** (`0xFCa0…FFEA`),
**AttestationRegistry**, **ACRFutures**, **FeedAccessAttestor**, **ReceiptMirror**
(`0xA9CD…DB65` — every x402 settlement, mirrored) and **HumanIdMirror** (`0x7f41…d8e5` —
which wallets are one person, per 7-day window). `src/mirror.ts` does the work:

- **`Settlement.slippageBp`** — unit price vs the *arrival* print (the last print posted
  before `settledAt`), in tenth-bp then rounded; `benchmarked: false` with a reason when
  no print existed yet.
- **`Settlement.human`** — `true` when `HumanIdMirror` records the payer in a cluster for
  the settlement's window. Stamped at finalize, never recomputed.
- **`SellerDay` / `PayerDay`** — daily rollups (volume, benchmarked volume, weighted
  slippage, overpay, bucket counts `b0..b6`) so a rating is one query, not a scan.
- **`SellerWindow`** — a seller's week denominated in **people** (`distinctHumans` vs
  `distinctPayers`): the manipulation bound's denominator.
- **`EconomicPrint`** — the deduplicated print across both oracles, with `policyHash`.

## Who reads it

| consumer | how |
|---|---|
| `GET /tca/{payer}` · `/rating/{seller}` · `/tca/human` | `services/index_api/index_api/tca.py` — every figure from these entities, `source: "subgraph"` on the card |
| the buyer agent's **reroute** (`apps/agent --reroute`) | reads `/tca/{payer}` and moves its next nanopayment to the cheaper seller |
| the Terminal's `/tape` | through `POST /graph/query` (server-side key, 13-operation allowlist) |
| the MCP server (`mcp/`) and `skills/acr-analyst/SKILL.md` | "Ask the Tape" — the NL interface |
| `make recompute` | re-derives the index from the indexed settlements and compares against the chain |

The **published print** (`/onchain/{id}`) is estimated from the simulator tape
(`ACR_TAPE_SOURCE=sim`, stated on `/health`); the Graph is the source of truth for
everything that measures what agents actually paid.

## Run it

```bash
npm ci
npm run codegen && npm run build
npm test                         # matchstick, 57 tests, no docker
make graph-deploy VERSION=v0.2.1 # needs the Studio deploy key; a new version re-indexes
```

Full runbook, including the `first: 1000` ceiling and the rotation trap:
[`docs/GRAPH-RUNBOOK.md`](../docs/GRAPH-RUNBOOK.md).
