# ACR buyer agent

The machine side of the marketplace: an agent that **discovers** ACR's listings
(`GET /marketplace/catalog`), **holds a wallet**, and **pays per query** via
x402 — Circle Nanopayments on Arc testnet in live mode, the DevFacilitator mock
gate offline. Every paid query lands in the public settlement ledger
(`GET /marketplace/receipts`) and on the Terminal's `/exchange` tape.

## Offline demo (no credentials, no chain)

```sh
# shell 1 — the index API with the dev gate
ACR_X402_MODE=dev make api
# shell 2
make agent            # = npm run start -- --dev --count 20 --discover --reroute
```

## Live (Arc testnet, real Gateway settlement)

Full runbook: [`docs/agent-runbook.md`](../../docs/agent-runbook.md). Short form:

```sh
export AGENT_PRIVATE_KEY=0x...   # a funded EOA with a Gateway deposit
make agent-live                  # = --live --count 60 --limit 0.01 --discover --reroute
```

Live mode uses Circle's official buyer SDK (`@circle-fin/x402-batching`
`GatewayClient`, chain `arcTestnet`): 402 → sign EIP-3009 against the
GatewayWallet → retry with `Payment-Signature` → decode the settle receipt.
The scheme is EOA-only (the facilitator `ecrecover`s the signature), which is
why the key is a raw EOA and not a custodial wallet.

## The reroute: a signal, then a decision, then a payment

With `--reroute` the agent reads **its own transaction costs** before it buys:
`GET /tca/{payer}` is computed from the tape the `acr-tape` subgraph indexes —
every settlement this wallet made, priced against the ACR benchmark at the
moment it arrived — and names the seller it overpaid most and the one it
overpaid least, with the saving in bp on past fills. The agent then:

- puts the suggested seller's listings **first**, so the next nanopayment lands there;
- **drops** the worst seller from this run;
- says so in one log line before any money moves, e.g.
  `reroute: 0xa1c8…fca4 → 0xefe0…df19 — past fills say 2893 bp (~$0.003381) cheaper; next payment goes to /compute/acr-seller-inf-open`

A wallet with no fills yet **holds** ("buying round-robin to create one"); so does
a saving under `--reroute-min-bp` (25 by default), and a suggested seller the
catalog no longer lists. The tape's own caveat applies: a saving on past fills is
arithmetic, not a promise — which is why the threshold exists. The same
suggestion is what the MCP tool `reroute_suggestion` returns and what `/tape`
shows on the Terminal; this flag is the agent acting on it.

## Flags

| flag | default | meaning |
|---|---|---|
| `--api` | `http://127.0.0.1:8000` | index API base |
| `--count` | 20 | paid queries to make |
| `--limit` | 0.01 | total spend cap, USDC (stops before exceeding) |
| `--dev` / `--live` | `--dev` | mock header vs real Gateway |
| `--discover` | off | buy from `/marketplace/catalog` instead of `--paths` |
| `--require-attested` | off | skip listings whose provider has no on-chain attestations |
| `--paths` | `/prints,/curve/ACR-INF,/vol/ACR-INF` | explicit resources |
| `--delay-ms` | 200 | pause between queries |
| `--reroute` | off | read `/tca/{payer}` first and let it choose the seller (needs `--discover`) |
| `--reroute-min-bp` | 25 | ignore a suggested saving smaller than this, in bp on past fills |

`AGENT_PRIVATE_KEY` is env-only by design (an argv key would show in `ps`).

## Checks

```sh
npm test           # hermetic node:test suite (stubbed fetch, no network)
npm run build      # tsc type-check
npm run interop    # against a running API: does our 402 parse the way
                   # GatewayClient.pay() parses it? (12 field-level checks)
```
