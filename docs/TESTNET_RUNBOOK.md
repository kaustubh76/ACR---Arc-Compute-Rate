# Testnet runbook — deploy, verify, and go live on Arc

The exact ordered operator sequence that takes ACR from "green offline test
suite" to "real contracts on Arc testnet, real signed prints, real x402
settlements on the tape". Every step is marked:

- **[OPERATOR]** — a human does it (keys, faucet clicks, `.env` edits, OTP).
- **[AUTOMATED]** — a make target / script does it; you only run the command.

> **Already live:** `ACROracle` `0x4f00e3BDd224F4c4b4958D54cD774E84B9092609` ·
> `AttestationRegistry` `0x23ae3E1A306824F0CBA0b6561cB7E5502f63dFb7` on chain
> `5042002`. Following §2–3 deploys a **new, divergent** contract pair — skip
> to §4 to run against the live ones instead. Cloud state:
> [`docs/DEPLOY.md`](DEPLOY.md); judge-facing status:
> [`docs/SUBMISSION.md`](SUBMISSION.md).

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

## 2b. Deploy the futures venue (ACRFutures) against the existing oracle

The cash-settled futures venue (pillar 4) settles against the **already-deployed**
`ACROracle` — so it is deployed on its own (`DeployFutures.s.sol`), NOT via
`Deploy.s.sol` (which would redeploy the oracle/registry). It reads
`ACR_ORACLE_ADDRESS` from the env, uses Arc's native USDC (`0x3600…0000`) for
collateral, and 20% initial margin by default (`ACR_FUTURES_MARGIN_BPS`).

```sh
ACR_ORACLE_ADDRESS=0x<the live ACROracle> \
DEPLOYER_PRIVATE_KEY=0x<funded deployer> \
make deploy-futures            # add --legacy to the forge call if EIP-1559 estimation fails
```

Then **seed a live series** (opens a series, maker + taker post USDC collateral —
verifying Arc's USDC `transferFrom` — and put on a trade so the desk shows a real
book). Small multiplier keeps notional within testnet balances:

```sh
ACR_FUTURES_ADDRESS=0x<from deploy-futures> \
MAKER_PRIVATE_KEY=0x<deployer / maker> \
TAKER_PRIVATE_KEY=0x<a second funded testnet key> \
uv run python scripts/futures_seed.py
```

**Live deployment (2026-07-31):** `ACRFutures` = `0x29d97c629a8278f7ec4218ab0bd8baa9182642fe`
(arcscan `/address/0x29d97c629a8278f7ec4218ab0bd8baa9182642fe`), settling against
oracle `0x4f00e3BDd224F4c4b4958D54cD774E84B9092609`; series 0 (ACR-INF, multiplier
10) seeded with a live long/short book. Arc's native USDC supports standard
`approve`/`transferFrom` — collateral works.

**Propagation:** set `ACR_FUTURES_ADDRESS` on the Render seller (env-var →
`/terminal/data` gains a `futures` block + `chain.futures_address`) and rebuild
the image so the new `FuturesReader`/`/futures` code ships. The Vercel Terminal
needs **no** futures env — it reads the address purely from `/terminal/data`.

## 3. Point `.env` at the deploy

**[OPERATOR]** Edit `.env` and set exactly these lines — the value on the
**SAME line** as the `=`, with **NO inline comments** (dotenv reads a trailing
`# comment` as part of the value; the repo's `.env` has previously shipped a
known-broken `ACR_X402_PAY_TO` whose "value" was literal comment text — this
line replaces it):

```
ACR_ORACLE_ADDRESS=0x<ACROracle address from step 2>
ACR_REGISTRY_ADDRESS=0x<AttestationRegistry address from step 2>
ACR_FUTURES_ADDRESS=0x<ACRFutures address from step 2b — optional; enables the desk>
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

Then `make attest-once` (and `make seed-sellers` if on the arc tape) — the
registry starts empty.

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
   `"oracle_configured": true` (and `"signer": "local"`). The production
   deployment signs via the Circle Developer-Controlled custody wallet instead
   (`ACR_CIRCLE_API_KEY` / `ACR_CIRCLE_ENTITY_SECRET` / `ACR_CIRCLE_WALLET_ID`
   — `/health` then shows `"signer": "circle"`).

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
(detail: [`docs/agent-runbook.md`](agent-runbook.md)). The Terminal can also
be the buyer itself: its **LIVE buyer** (`ACR_BUYER_PRIVATE_KEY`, hard $0.01
cap) originates real Gateway settlements from `/exchange` — see agent-runbook
§4b.

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

## 5b. The Public Desk — a reader trades with their own wallet

The desk lets a visitor open a Circle **user-controlled** wallet (an SCA on
Arc, PIN-secured in Circle's hosted UI) and take a real position against the
maker. The key is derived and held client-side, so — unlike every other flow in
this runbook — **no server-side script can stand in for the ceremony**. The
only honest verification drives a browser.

1. **[AUTOMATED]** `make desk-preflight` — read-only gates: the series has
   life left, the oracle mark is fresh, the margin math leaves a tradable
   size, the maker can absorb it both ways, and the custody wallet (the faucet
   source) is funded. Exit 0 means clear to run.
2. **[OPERATOR]** `make api` and `ACR_API=http://127.0.0.1:8000 make terminal`.
   Hit `/api/futures` once first — a cold roster read can exceed the proxy's
   upstream timeout, and the desk renders read-only until it answers.
3. **[OPERATOR, once]** `npm i playwright && npx playwright install chromium`
   anywhere (Node ≥ 20). Playwright is deliberately not a repo dependency.
4. **[AUTOMATED]** `PLAYWRIGHT_DIR=<that>/node_modules make desk-e2e` — drives
   PIN setup → faucet → `approve` → `postCollateral` → `trade`, then writes
   `data/desk_e2e_last.json`. Set `DESK_PROFILE=<dir>` to reuse one browser
   profile (and therefore one wallet) across runs; the faucet is one drip per
   address, so a fresh profile per attempt burns the cap.
5. **[AUTOMATED]** `make desk-evidence USER_ID=<the id the run printed>` —
   confirms the run from two directions: Circle's own transaction ledger
   (states, hashes, fees) and the venue's `CollateralPosted` / `Traded` logs
   plus a live `positionOf`.

### The first live run — 2026-08-01, series 0 (ACR-INF)

Wallet `0x95DE70736E21e70DF921Fb3ab91dD56750965b59` (Circle user
`acr-desk-1gkdjcmj`), driven entirely through the browser under a PIN:

| Step | Transaction |
|---|---|
| faucet drip (0.5 USDC, from custody) | [`0xb6ef0981…`](https://testnet.arcscan.app/tx/0xb6ef098134690045ebf4012c8d2e28573d1c45d499e859efbf22efabb7d41572) |
| `approve` USDC → the venue | [`0xb4ed94b9…`](https://testnet.arcscan.app/tx/0xb4ed94b9c5c6fdef97fdce407e05b1b56405b66b20a229cccab3f49b9d0998c3) |
| `postCollateral` 0.50 USDC | [`0x272687b1…`](https://testnet.arcscan.app/tx/0x272687b15c31110cb7e64b4dfb540c49fac15bb7095f89ba9bf263c8101a1916) |
| `trade` **+0.46 @ 0.48450** | [`0x0888fb1b…`](https://testnet.arcscan.app/tx/0x0888fb1bdf73313ecc9b9374c66c6cd70c9fb5813ae03f163450eecf26237876) |

`positionOf(0, wallet)` reads back `0.46 contracts @ 0.48450`.

Three facts this run settled, each previously assumed:

- **Gas Station sponsors these SCAs.** The authority is the ERC-4337
  `UserOperationEvent`'s `paymaster` field — here
  `0x7cea357b5ac0639f89f9e378a1f03aa5005c0a25`, i.e. sponsored. Do **not** read
  Circle's `networkFee` as a user debit: it is non-zero on every one of these
  operations and the wallet still paid nothing. The balance agrees — 0.500000
  in, 0.5 posted as collateral, 0.000000 left.
- **Every desk action is a smart-account user operation**, routed through the
  EntryPoint at `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` rather than a
  direct call.
- **$0.50 buys well under one contract** on a 10× index (~0.9955 USDC of
  initial margin per contract at a 0.4977 mark) — which is why the desk quotes
  a server-computed size (here 0.46) instead of a hardcoded 1. A "BUY 1" button
  would have reverted `taker margin` *after* the reader entered their PIN.

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
