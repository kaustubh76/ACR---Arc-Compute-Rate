# Testnet runbook — deploy, verify, and go live on Arc

The exact ordered operator sequence that takes ACR from "green offline test
suite" to "real contracts on Arc testnet, real signed prints, real x402
settlements on the tape". Every step is marked:

- **[OPERATOR]** — a human does it (keys, faucet clicks, `.env` edits, OTP).
- **[AUTOMATED]** — a make target / script does it; you only run the command.

Chain facts this runbook is built on:

| fact | value |
|---|---|
| chain id | `5042002` (CAIP-2 `eip155:5042002`) |
| RPC | `https://rpc.testnet.arc.network` |
| explorer | `https://testnet.arcscan.app` |
| gas token | **USDC** — a native system contract at `0x3600000000000000000000000000000000000000` |
| faucet | `https://faucet.circle.com` → network **Arc Testnet** |
| x402 facilitator (testnet) | `https://gateway-api-testnet.circle.com` |

Related: [`docs/agent-runbook.md`](agent-runbook.md) (the buyer-agent detail
this runbook's step 5 condenses), [`docs/IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

---

## 1. Fund the poster wallet

The oracle poster signs prints EIP-712 (domain "ACR Oracle" v1) with
`ACR_POSTER_PRIVATE_KEY` and relays them itself — so its address needs USDC,
which on Arc **is** the gas.

1. **[OPERATOR]** Derive the poster address from the key already in `.env`:

   ```sh
   uv run python -c "from acr_core import get_settings; from eth_account import Account; print(Account.from_key(get_settings().poster_private_key).address)"
   ```

2. **[OPERATOR]** Open `https://faucet.circle.com`, pick **Arc Testnet**, paste
   the address, request USDC.

3. **CHECKPOINT** — `https://testnet.arcscan.app/address/<poster address>`
   shows a non-zero USDC balance.

## 2. Deploy the contracts (Foundry)

Use the **same key** as the deployer: `ACROracle`'s constructor auto-authorizes
the deployer as a signer, so poster == deployer means no extra `setSigner` step.

1. **[OPERATOR]** Export the key (env only — never paste it into a file):

   ```sh
   export DEPLOYER_PRIVATE_KEY=0x<the ACR_POSTER_PRIVATE_KEY value>
   ```

2. **[AUTOMATED]** Simulate first — no broadcast, catches RPC/balance/compile
   problems for free:

   ```sh
   make deploy-testnet-dry
   ```

3. **[AUTOMATED]** Deploy for real and note the two addresses from the forge
   log (`ACROracle: 0x…`, `AttestationRegistry: 0x…`):

   ```sh
   make deploy-testnet
   ```

   If forge's EIP-1559 fee estimation fails on Arc, retry the same command
   with `--legacy` appended to the forge invocation:

   ```sh
   cd contracts && forge script script/Deploy.s.sol \
     --rpc-url https://rpc.testnet.arc.network \
     --private-key $DEPLOYER_PRIVATE_KEY --broadcast --legacy
   ```

4. **CHECKPOINT** — both `https://testnet.arcscan.app/address/<address>` pages
   show **contract code** (not an empty EOA).

## 3. Point `.env` at the deploy

**[OPERATOR]** Edit `.env` and set exactly these lines — the value on the
**SAME line** as the `=`, with **NO inline comments** (dotenv reads a trailing
`# comment` as part of the value; the repo's `.env` has previously shipped a
known-broken `ACR_X402_PAY_TO` whose "value" was literal comment text — this
line replaces it):

```
ACR_ORACLE_ADDRESS=0x<ACROracle address from step 2>
ACR_REGISTRY_ADDRESS=0x<AttestationRegistry address from step 2>
ACR_X402_PAY_TO=0x<seller wallet that receives USDC — the deployer EOA is fine>
ACR_X402_FACILITATOR_URL=https://gateway-api-testnet.circle.com
ACR_EXPLORER_BASE=https://testnet.arcscan.app
```

Only if the poster key is **not** the deployer key (skip otherwise): authorize
it as an oracle signer —

```sh
cast send <ACR_ORACLE_ADDRESS> "setSigner(address,bool)" <poster address> true \
  --rpc-url https://rpc.testnet.arc.network --private-key $DEPLOYER_PRIVATE_KEY
```

## 4. Verify, serve, post the first prints

1. **[AUTOMATED]** Read-only preflight — chain id, bytecode at both addresses,
   poster `isSigner()`, per-index `latestPrint` ("no print yet" is expected
   before the first post), arcscan links:

   ```sh
   make verify-testnet
   ```

   Exits non-zero on any ✗ — including a still-unconfigured `.env`
   ("no oracle configured — run the deploy first").

2. **[AUTOMATED]** Serve the API, then **[OPERATOR]** check the health card:

   ```sh
   make api            # leave running
   curl -s localhost:8000/health
   ```

   Expect `"gate": "circle"` (the real x402 gate engaged) and
   `"oracle_configured": true` (and `"signer": "local"`).

3. **[AUTOMATED]** One estimator cycle → signed `postPrint` per index:

   ```sh
   make post-once
   ```

4. **CHECKPOINT** — the script prints one
   `https://testnet.arcscan.app/tx/0x…` per index and the tx pages show
   successful `postPrint` calls; the Terminal (`make terminal` →
   `/index/ACR-INF`) shows the **settled on-chain** mark with the tx link.

## 5. The buyer loop — live x402 nanopayments

The buyer agent needs its own funded EOA plus a Circle Gateway deposit
(detail: [`docs/agent-runbook.md`](agent-runbook.md)).

1. **[OPERATOR]** `make circle-login EMAIL=you@example.com` — email-OTP,
   testnet session (CLI v0.0.6 auto-provisions agent wallets on login).
2. **[OPERATOR]** `make buyer-key` then `make circle-wallet` — the x402 `exact`
   scheme is EIP-3009, signed with a **raw** key, but v0.0.6 `circle wallet
   create` only makes custodied agent wallets, so `buyer-key` mints a testnet
   EOA and `circle-wallet` **imports** it (`circle wallet import buyer
   --private-key`). Then `export AGENT_PRIVATE_KEY=0x…` (the same key — env
   only, never an argv).
3. **[OPERATOR]** Fund the buyer address at `https://faucet.circle.com`
   (Arc Testnet), or `make circle-fund ADDR=0x<buyer>`.
4. **[OPERATOR]** `make circle-deposit ADDR=0x<buyer>` — deposits USDC into
   Gateway (minimum **0.5**, chain `ARC-TESTNET`); the Gateway balance is what
   x402 spends.
5. **[AUTOMATED]** `make interop` (with `make api` still running) — 12
   field-level checks that our 402 parses exactly as `GatewayClient.pay()`
   parses it. Expect 12/12 PASS.
6. **[AUTOMATED]** `make agent-live` — 60 discovery-driven paid queries,
   $0.01 cap.
7. **CHECKPOINT** — the Terminal's `/exchange` tape fills with settlements;
   receipts carry scheme `exact` and network **exactly** `eip155:5042002`.

## 6. Bake the real artifacts into the offline bundle

**[AUTOMATED]** With the oracle configured in `.env`:

```sh
make snapshot
```

Regenerates `apps/terminal/lib/fallback.json` through the same code path that
serves `/terminal/data`, so the offline Terminal edition now ships real
on-chain provenance instead of the chain-agnostic placeholder.

---

## Risks & fallbacks

- **Gateway settle refs may be UUIDs, not tx hashes.** Gateway batches
  nanopayments; each payment gets a settlement *reference* and the on-chain
  batch tx lands separately. Don't paste a UUID into arcscan `/tx/` — the
  honest transaction story is "N x402 payments + Gateway batch settlements +
  the oracle's own `postPrint` txs".
- **EIP-1559 estimation can fail on Arc** — retry the forge script with
  `--legacy` (step 2). The Makefile target's comment carries the same note.
- **If live fails mid-demo, nothing bricks:** the UI degrades to the sim tier
  automatically — offline-tolerance is a repo invariant (dev gate, simulator
  tape, offline poster markers). Fix the credential/RPC issue and re-run the
  step; nothing needs resetting.
- **`verify_deploy.py`'s "last post" link is best-effort** — it scans the most
  recent ~50k blocks of `PricePosted` logs and skips quietly if the public RPC
  declines the range. The per-index `make post-once` output is the
  authoritative tx list.
- **Faucet rate limits**: the Circle faucet caps requests per address per day;
  fund both the poster and the buyer early.
