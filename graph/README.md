# `acr-tape` — the subgraph that makes TCA a number

The Graph is **load-bearing** here, not a mirror of an API: every settlement an agent
makes on Arc is benchmarked *in the mapping*, at the moment it arrives, against the
ACR print it could have seen — and that `slippageBp` is the only input transaction-cost
analysis, seller ratings and the reroute decision have. Nothing downstream recomputes
it; nothing can disagree with it.

| | |
|---|---|
| **Studio (mainnet)** | account `1762718` · slug `acr` · **v1.0.0-mainnet** · `QmZ5tUKEv9SY5CiUUDPyHyWFpm9LfZJefRbMy9JUPbPJzs` |
| **Studio (testnet)** | account `1758707` · slug `ethonline` · **v0.2.0** · `QmdsGieTC7B4KTyd2pEhV1wmFLCeF1yCYwLLgBXL2a9Ci6` |
| **Endpoint (development)** | `https://api.studio.thegraph.com/query/1762718/acr/v1.0.0-mainnet` — 3,000 queries/day, no key, and what `ACR_SUBGRAPH_URL` points at today |
| **Endpoint (production)** | `https://gateway.thegraph.com/api/subgraphs/id/N69YD8crrapYQ8ap71bVmQPKY6g4SjzwYJCEAVTmnJw` — **published**. Use THIS URL shape, not the `…/api/[api-key]/subgraphs/…` one Studio shows: `graph_query` sends the key as an `Authorization: Bearer` header (`ACR_GRAPH_API_KEY`), and the path-less form is the one that accepts it. Unauthenticated it answers `auth error: missing authorization header` |
| **Network** | `arc` (`eip155:5042`) since 2026-09-27, and `arc-testnet` (`eip155:5042002`); both live in `networks.json` |
| **Lag, measured** | ~6 blocks / ~3 s behind Arc's head (2026-09-13), `hasIndexingErrors: false` |
| **Substreams** | **N/A** — Arc is a Studio-only ("basic" support) network; there is no Substreams endpoint to target, so that challenge is not attempted |

## The manifest is generated — edit `networks.json`, not `subgraph.yaml`

`graph build --network <arc|arc-testnet>` rewrites `subgraph.yaml` in place from
`networks.json`: it swaps every `network`, `address` and `startBlock`, **and strips every
comment in the file** (it round-trips the YAML through a serializer). So nothing durable can
live in that manifest's comments, which is why these two facts live here instead:

- **`specVersion: 1.1.0` is the floor** for `@entity(timeseries: true)` / `@aggregation`.
  Lowering it breaks the schema, not just a warning.
- **ABIs under `abis/` are extracted from `contracts/out` by `make graph-abis`** and are never
  hand-written. The Terminal's hand-inlined ABIs have drifted from the contracts before; a
  generated copy cannot.

Switch networks with `make graph-build NETWORK=arc-testnet` (it defaults to `arc`). Mainnet
addresses and start blocks came from the deploy's own broadcast receipts, not from the
explorer — Arc's mainnet explorer API is credentialed and answers 403.

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
npm test                         # matchstick, 58 tests, no docker
make graph-deploy VERSION=v0.2.1 # needs the Studio deploy key; a new version re-indexes
```

Full runbook, including the `first: 1000` ceiling and the rotation trap:
[`docs/GRAPH-RUNBOOK.md`](../docs/GRAPH-RUNBOOK.md).
