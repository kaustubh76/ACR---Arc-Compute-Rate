# Agent runbook — live Circle Agent Stack on Arc testnet

The end-to-end live loop: a buyer agent with its own wallet discovers ACR's
listings, pays sub-cent USDC nanopayments per query via x402, Circle Gateway
settles them, and the receipts print on the Terminal's `/exchange` tape.

Everything here is **live-mode only**. The credential-free demo needs none of
it: `ACR_X402_MODE=dev make api` + `make agent`.

## 0. One-time setup

```sh
npm install -g @circle-fin/cli     # Node >= 20.18.2; verify: make circle-check
```

The CLI requires a one-time Terms acceptance (interactive prompt, or
`CIRCLE_ACCEPT_TERMS=1` in non-interactive shells).

Circle Skills for coding agents are already installed as the
`circle-skills@circle` Claude Code plugin (`make skills-install` re-runs it) —
notably `use-agent-wallet`, `fund-agent-wallet`, `pay-via-agent-wallet`, and
`use-circle-cli`.

## 1. The buyer wallet (Circle CLI v0.0.6)

The buyer needs a **raw, exportable** EOA key: the x402 `exact`/GatewayWalletBatched
scheme is EOA-only (the facilitator `ecrecover`s the EIP-3009 signature) and the
agent signs with the key itself. In CLI v0.0.6 `circle wallet create` only makes
Circle-custodied *agent* SCA wallets (no exportable key), so a local wallet comes
via **import**:

```sh
make circle-login EMAIL=you@example.com   # email OTP, testnet session (auto-provisions agent wallets)
make buyer-key                            # generate a fresh testnet EOA — prints address + key
make circle-wallet                        # circle wallet import buyer --private-key  (paste the key from above)
export AGENT_PRIVATE_KEY=0x...            # the same key — env only, never an argv
```

The Arc chain name in the CLI is **`ARC-TESTNET`** (EVM 5042002). Never reuse a
key that holds real funds — `buyer-key` is testnet-only.

## 2. Fund it and open a Gateway balance

The v0.0.6 wallet/gateway verbs all require `--address` + `--chain`; the make
targets pass `ADDR=` and default the chain to `ARC-TESTNET`:

```sh
make circle-fund    ADDR=0x<buyer>   # testnet faucet drip (or https://faucet.circle.com, Arc Testnet)
make circle-deposit ADDR=0x<buyer>   # gateway deposit --amount 0.5 … --chain ARC-TESTNET --method direct
make circle-balance ADDR=0x<buyer>   # wallet + Gateway balances
```

The Gateway deposit is what makes payments **gasless** thereafter: the agent
signs authorizations offchain; Gateway batches and settles them. The wallet must
already hold USDC first (USDC is Arc's native gas). CLI v0.0.6 `--method` rule:
**local wallets** (`circle wallet import`) deposit on-chain and **reject
`--method`** — omit it (`make circle-deposit ADDR=…`); **agent wallets require**
it (`make circle-deposit ADDR=… METHOD=direct`; `eco` is BASE-sources-only,
`direct` covers ARC-TESTNET). The target passes `--method` only when `METHOD=`
is set. Override the size with `AMOUNT=`.

## 3. The seller side (this repo)

1. **Fresh `.env`** — copy from `.env.example` and fill. Do **not** reuse an
   old `.env` (a known-broken one with inline-comment values may exist; the
   config layer blanks `#`-leading values, but a clean file is the fix).
2. Set at minimum:
   - `ACR_X402_PAY_TO=0x...` — the seller wallet that receives USDC
   - `ACR_X402_FACILITATOR_URL=https://gateway-api-testnet.circle.com`
     (prefilled; `/v1/x402/verify` + `/settle` are appended automatically)
   - leave `ACR_X402_MODE=auto` — the Circle gate engages once both are real
3. `make api` — `curl -s localhost:8000/health` should report `"gate": "circle"`.

Optional on-chain provenance: deploy contracts via
`scripts/deploy_circle.py` (Circle Smart Contract Platform) and set
`ACR_ORACLE_ADDRESS` / `ACR_REGISTRY_ADDRESS`; the catalog then carries
attestation-backed listings and `--require-attested` becomes meaningful.

## 4. Run the buyer

```sh
make interop      # 12 field-level checks: our 402 vs GatewayClient's parser
make agent-live   # 60 queries, $0.01 cap, discovery from /marketplace/catalog
```

Each line prints the Gateway settlement reference; the summary block totals
payments and distinct settlements. Watch them land live on the Terminal's
**Exchange** tape (`make terminal` → /exchange) and in
`GET /marketplace/receipts`.

For the judges: 60 payments × $0.0001 ≪ the $0.01/action ceiling. Gateway
settles in **batches** — each payment gets a settlement reference (UUID), and
Gateway posts batched on-chain transactions; the honest tx story is
"60 x402 payments + Gateway batch settlements + the oracle's own signed
`postPrint` transactions", not "60 L1 transactions".

## 4b. Trigger a REAL settlement from the Terminal UI

The Terminal itself can be the buyer — no separate `apps/agent` process. The
Next.js server holds a funded key and originates real Circle Gateway payments
when you click a button on **/exchange** or **/developers** (the "Wire" console).

```sh
# The Terminal server (Node) needs the SAME kind of funded key as the agent:
export ACR_BUYER_PRIVATE_KEY=0x...   # a funded EOA with an OPEN Gateway deposit
export ACR_API=http://127.0.0.1:8000 # a seller whose /health gate == "circle"
make terminal                        # or: cd apps/terminal && npm run start
```

Then:
- **/exchange** → *Release the LIVE buyer — 3 real settlements* fires three real
  x402 exchanges; each gateway-ref prints on the tape, `/revenue` climbs, and the
  **Circle Gateway wallet** panel shows the buyer's deposit ticking down.
- **/developers → The Wire** → in Circle mode the console shows the real 402
  challenge (x402Version 2, GatewayWalletBatched, verifyingContract) and a
  *Settle for real →* action that signs EIP-3009 and settles one query live.

Safety: `ACR_BUYER_PRIVATE_KEY` is **server-only** (never `NEXT_PUBLIC_`, never
sent to the browser). Every UI run enforces a hard **$0.01 cumulative cap** and
refuses on the dev gate (409) so a mock header can never masquerade as real.
Without the key the LIVE controls stay disabled with an honest hint. Uses the
same `@circle-fin/x402-batching` `GatewayClient` as `apps/agent`
(`apps/terminal/lib/gatewayBuyer.ts`).

## 5. Cross-checks with the Circle CLI

```sh
circle services search --output json        # is ACR discoverable in the wild?
circle services inspect <our-resource-url>  # how our 402 descriptor reads
circle services pay <our-resource-url> --max-amount 0.001
```

`circle services pay` is an independent buyer implementation — if it settles
against our gate, interop is proven twice.

## 6. Circle Agent Marketplace listing

Circle's directory (https://agents.circle.com/services) has no self-serve
listing API today — submission is a form. Materials to paste: the service name
("ACR — The Arc Compute Rate"), the `/marketplace/catalog` JSON (it already
carries per-resource descriptions, prices, and input/output schemas), and the
public API base URL.

## Troubleshooting

| symptom | likely cause |
|---|---|
| `make agent-live` → "No Gateway batching option" | seller gate is in dev mode (mock accepts) or wrong network — check `/health` gate + `eip155:5042002` in `/x402/info` |
| 402 `settlement failed: insufficient_balance` | Gateway deposit missing/spent — `make circle-deposit` |
| 402 `payment invalid: invalid_signature` | wrong `ACR_X402_GATEWAY_WALLET` (verifyingContract) for the network |
| agent throws before paying | `AGENT_PRIVATE_KEY` unset or not `0x`-prefixed |
