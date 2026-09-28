# Arc mainnet — the ordered deploy

*Arc public mainnet (`eip155:5042`) opens 2026-09-16. This is the sequence that puts ACR on it,
written before the chain exists so that nothing on the day is a decision. Every step below was
rehearsed on `arc-testnet` (`eip155:5042002`), where the identical five scripts produced the
addresses in `render.yaml`. `make deploy-mainnet-dry` simulates all five against the mainnet RPC
and refuses to proceed if the RPC answers with any other chain id.*

**Deployment-ready, not deployed** — stated plainly because the Arc continuity bounty asks for
one or the other. Deployed on testnet since 2026-07; the mainnet transaction hash will be added
here and in `README.md` the day it lands.

## 0 · What is chain-specific, and what is not

| | testnet | mainnet |
|---|---|---|
| chain id | `5042002` | `5042` |
| RPC | `https://rpc.testnet.arc.network` | `https://rpc.mainnet.arc.io` is **public** (probed 2026-09-21, `eth_chainId` → `0x13b2`, no credentials); run the press on a keyed provider URL (Alchemy, QuickNode, dRPC, Blockdaemon all list Arc) and set `ACR_MAINNET_RPC_URL` to that |
| USDC | `0x3600…0000` (native) — **defaulted** in the scripts | **not defaulted**: `ACR_MAINNET_USDC` is required, so a testnet constant cannot ride onto mainnet by omission |
| explorer | `testnet.arcscan.app` | `https://explorer.arc.io` (public; the chain profile carries it) |
| gas | USDC | USDC — `Deploy.s.sol` 4.13M · `DeployOracleV2` 1.51M · `DeployReceiptMirror` 1.43M · `DeployHumanIdMirror` 1.00M · `DeployFutures` 2.23M ≈ **0.46 USDC** total at testnet prices |

Everything else — the estimator, the oracle's EIP-712 domain (binds `chainId`), the x402 gate,
the subgraph mappings, the Terminal — reads the chain id from configuration and changes nothing.

## 1 · Before the first transaction

```sh
export ACR_MAINNET_RPC_URL=https://...            # Arc's mainnet RPC
export ACR_MAINNET_USDC=0x...                     # Arc's mainnet USDC (read it from Arc's docs, do not guess)
export DEPLOYER_PRIVATE_KEY=0x...                 # a FRESH key, funded with >= 1 USDC for gas — single-use, see §3b
export ACR_EXPECTED_OWNER=0x...                   # who owns the contracts after §3b: the multisig, or the custody wallet until one exists
export ACR_HUMANID_SALT_COMMITMENT=0x...          # keccak of the salt — the SALT itself never leaves the operator's machine
make deploy-mainnet-dry                           # five simulations; exits 1 on a wrong chain id
```

The dry run is the gate. If any script fails to simulate, nothing is broadcast and the fix is made
here, not on chain.

## 2 · Deploy, in this order

```sh
export ACR_PRESS_SIGNER=0x...                     # the press custody wallet — the ONLY key that will sign prints
make deploy-mainnet
```

One script, one broadcast — `DeployMainnet.s.sol` — because the order carries dependencies
and the custody has to land in the same transaction as the contracts, not in a ceremony
someone can forget:

1. **ACROracle (v1)** and **AttestationRegistry**.
2. **ACROracleV2**, constructed with `MAX_MOVE_BPS` (2 000: a print moves at most 20% from
   the last; a stolen key walks, it does not jump).
3. **ACRFutures**, constructed against **v2** — its oracle pointer is immutable, which is why
   v2 exists before it. The venue's settlement views are primitives, so v1 or v2 works; v2 is
   the one with the bound.
4. **ReceiptMirror**, **HumanIdMirror** (with the salt commitment), **FeedAccessAttestor**.
5. `setSigner(press, true)` on every signing contract, then **`setSigner(deployer, false)` on
   every one** — each constructor grants the deployer a signer bit, and this is where it is
   taken back. After this broadcast the deploy key signs nothing.
6. If `ACR_EXPECTED_OWNER` is set: `transferOwnership` to it on all six owned contracts.
   The `acceptOwnership` half is §3 step 5 — the new owner's own act, deliberately.

Then `make backfill-oracle-v2` BEFORE any live post, so v2 carries the history the venue
will settle against.

The per-contract scripts (`Deploy.s.sol`, `DeployOracleV2.s.sol`, …) remain for testnet and
for adding one contract to an existing deployment; they are not the mainnet path.

## 3 · After the addresses exist

1. **Configuration.** `render.yaml` already carries the mainnet service, `acr-api-mainnet`,
   with every variable the guard requires — review that block, paste the `sync: false`
   values into the dashboard, fill the addresses from the deploy output. The service
   **refuses to boot** on 5042 until the gates are explicit and configured
   (`acr_core.mainnet_guard`); read its one raise, fix every line it lists, redeploy.

   The terminal (Vercel) is a separate build with its own variables:

   | variable | value | why |
   |---|---|---|
   | `NEXT_PUBLIC_ACR_API` | *(optional)* the seller's URL | **a production build already defaults to `https://acr-api-mainnet.onrender.com`** (`lib/apiBase.ts`), because `http://127.0.0.1:8000` is nothing on a server. Set it only to point somewhere else — a fork, a preview, a testnet deploy |
   | `NEXT_PUBLIC_ACR_CHAIN_ID` | *(optional)* `5042` | a belt-and-braces assertion: `lib/chain.test.ts` fails the build if the cold-start bundle is from another chain. Unset, the bundle's own chain is accepted — and the committed bundle is already 5042 |
   | `ACR_API` | *(optional)* same as above | server routes; falls back to the same default |
   | `ACR_ARC_RPC_URL` | a keyed provider URL for mainnet | server-side reads (balances, on-chain routes); never reaches the browser — a visitor's wallet is handed the payload's `public_rpc_url` (`https://rpc.mainnet.arc.io`) |
   | `ACR_TERMINAL_BUYER` | **unset** | the house buyer must not spend on a stranger's click; set to `1` only deliberately |
   | `ACR_BUYER_PRIVATE_KEY` | **unset** | same; there is no house buyer on mainnet unless you mean it |

   Then, BEFORE the Vercel deploy: `make snapshot` against the mainnet API, so the bundle a
   visitor sees while the press naps is mainnet data under a mainnet masthead. The build
   fails otherwise — that is the test doing its job.

2. **Subgraph.** `graph/subgraph.yaml`: network `arc`, each data source's `startBlock` = its
   deploy block; `make graph-deploy VERSION=v1.0.0-mainnet`. The Graph's registry lists `arc`
   as a Studio target (verified 2026-09-01, `hackathon/ethonline-2026/SPIKE-LOG.md`).
3. **Humans.** `make resolve-humans ARGS=--commit` for the current rotation window BEFORE any
   tape is generated, or the first week's settlements carry `human: false` forever.
4. **Signers.** Authorise the poster on v1 and v2, the mirror signer on ReceiptMirror, the
   resolver on HumanIdMirror — each script prints the `authorized signer` it set.
5. **Custody — before any user touches it.** `DeployMainnet.s.sol` already retired the
   deploy key as a signer and started the ownership hand-over. What remains is the half
   only the new owner can do — from `ACR_EXPECTED_OWNER`, on each of the six contracts:

   ```sh
   cast send $CONTRACT 'acceptOwnership()' --rpc-url $ACR_MAINNET_RPC_URL --private-key $OWNER_KEY
   ```

   After the last one, the deploy key owns nothing and signs nothing. Move it out of `.env`.
   If a Safe exists on Arc mainnet, `ACR_EXPECTED_OWNER` is the Safe; if not yet, it is the
   Circle custody owner wallet, and `docs/SECURITY.md` says so until that changes. The
   audit that made this a step: [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md), C1.
6. **Prove it.** `make verify-mainnet` — the same preflight as testnet plus the custody
   checks, which are **hard failures on chain 5042**: no pending transfer, every owner equals
   `ACR_EXPECTED_OWNER`, the deploy key is neither owner nor signer, the press wallet signs.
   Then `make verify-live` against the redeployed API; its last section, *revenue*, checks
   the two ways a human pays (a 402 a wallet can sign, a Desk pass claim that refuses a
   stranger). Paste the first `postPrint` transaction hash into `README.md` and this file.
7. **Buy one thing yourself.** On the terminal, `/exchange` → any listing → *connect your
   wallet to buy* → *buy with your wallet*. A row on the tape, a receipt under
   `/api/marketplace/receipts`, and `/api/revenue` moving by the listing's price is the
   first mainnet revenue, and the proof the storefront works without the house buyer (which
   is off on 5042 unless `ACR_TERMINAL_BUYER=1`). No USDC on Arc yet? The same row bridges
   it from Base, Ethereum, Arbitrum, OP or Polygon (CCTP, inside the terminal) first.

## 4 · What does not move on day one

- **The futures venue opens with the demo maker only.** Real liquidity is a listing decision, not
  a deploy step.
- **The seller fleet stays on testnet** until real sellers exist; mainnet TCA begins with the
  first real x402 settlement to ReceiptMirror.
- **No funds are bridged by this runbook.** Gas is the only USDC it spends.

## 5 · Launch day, in order

> **Rows 1, 2a, 3 and 5 are DONE (2026-09-27).** Seven contracts are on chain, the image is
> rebuilt and pinned, `acr-api-mainnet` is live and answering, and the first three prints are
> posted. `data/mainnet-addresses.txt` (gitignored) holds every address. What remains, in the
> order it unblocks things:
>
> 1. **`acceptOwnership()` ×6 from `0xE804f54109b627205B31149965e534837D046dAd`** — only that key
>    can. Until then the *deploy key* still owns the contracts, so
>    **`data/mainnet-deploy-key.txt` must not be deleted yet**. It holds ~0.84 USDC that should be
>    swept back to the press afterwards.
> 2. ~~**A signer for the press on the host.**~~ **DONE** — `ACR_POSTER_PRIVATE_KEY` is set on the
>    service and it posted by itself (`0x09444bf8…f946d`). Disclosed in `docs/SECURITY.md`. The
>    press then stopped, because the free instance is OOM-killed faster than its hourly timer;
>    `ACR_WAKE_POST_AFTER_S=1200` is the interim fix and row 3a is the real one. Superseded note: the mainnet service
>    holds no key, by the same rule the testnet service follows (`ACR_CIRCLE_WALLET_ID`, never a
>    raw key in an env var). So the three prints were posted from a laptop and **the fixing will
>    not update on its own.** Either create the Circle **live** wallet set and set
>    `ACR_CIRCLE_WALLET_ID`, or accept a raw `ACR_POSTER_PRIVATE_KEY` on Render — the blast radius
>    of that key is now bounded by `ACROracleV2.MAX_MOVE_BPS`, which it was not when this rule was
>    written.
> 3. **Prove revenue with a payer that is not the treasury.** `ACR_X402_PAY_TO` is the press
>    wallet, and Circle's facilitator refuses `self_transfer`, so the press cannot buy from
>    itself. Fund any other wallet, deposit to Gateway, then
>    `PROBE_KEY=… SELLER=https://acr-api-mainnet.onrender.com make wallet-settle-probe`.
> 4. **Upgrade the Render plan from `free` to `starter`** (row 3a) and seed a futures series.


The community will do steps 1–5 of [`COMMUNITY-TEST.md`](COMMUNITY-TEST.md). Everything below
has to be true before the link goes out; each line names who can do it (the code cannot).

| # | do | who / what it needs | proves |
|---|---|---|---|
| 1 | `make deploy-mainnet` (§2) with a **fresh** funded deploy key, `ACR_PRESS_SIGNER`, `ACR_EXPECTED_OWNER` | operator: keys + ~1 USDC of gas on 5042 | seven contracts, deployer signs nothing |
| 2 | `acceptOwnership()` ×6 from the owner (§3 step 5); move the deploy key out of `.env` | the owner key | custody |
| 2a | **Rebuild and push the image.** `docker build --platform linux/amd64 -t kaushtubh02/acr-api:$(date +%F) -t kaushtubh02/acr-api:latest . && docker push` both tags | Docker Desktop running (ask the daemon: `docker version --format '{{.Server.Version}}'` — `docker info` exits 0 even when it cannot connect), `docker login` | **Render pulls a prebuilt image and there is no CI build**, so `:latest` means "whatever was last pushed". On 2026-09-26 that was a 09-13 build predating `mainnet_guard` itself — a mainnet service from it would have run the fail-open code the audit closed. Prove the new code is *inside* the image rather than trusting the build log: `docker run --rm --platform linux/amd64 --entrypoint sh <tag> -c 'uv run --no-sync python -c "from acr_core.mainnet_guard import violations; from acr_core.config import CHAIN_PROFILES; print(CHAIN_PROFILES[5042].public_rpc)"'`. `render.yaml` pins the dated tag |
| 3 | Render `acr-api-mainnet` **already exists**: `srv-das1navlk1mc73dvsm8g` in workspace `tea-d9dgp6n41pts73d3ueu0`, at `https://acr-api-mainnet.onrender.com`, image pinned, 26 env vars set, **suspended on purpose**. Three things remain, all secrets: `ACR_X402_PAY_TO` (treasury), `ACR_HUMANID_APP_ID`, a keyed `ACR_ARC_RPC_URL` — plus the addresses after step 1 and the Circle **LIVE** key + entity secret (test keys do not open `ARC` wallets). Patch them **one key at a time**: the bulk env PUT replaces every var. Env edits do not restart a service — redeploy with `SKIP_BUILD`. | Circle console (live env), Render dashboard | the guard lets it boot |
| 3a | **Upgrade the plan from `free` to `starter`. Measured as REQUIRED, not preferred.** On free (512 MiB) the service's `rss` climbs past 380 MiB within two minutes of boot and it is OOM-killed repeatedly: uptime observed at **1.9 minutes**, so the hourly poster timer never fires at all. `ACR_WAKE_POST_AFTER_S=1200` makes each restart top the record up, which stops the fixing freezing, but it treats the symptom — the press is still restarting every few minutes. Add a card, then `PATCH /v1/services/<id>` with `plan: "starter"`, and drop `ACR_WAKE_POST_AFTER_S` once it holds. | a card on the Render workspace | the press survives long enough to keep its own cadence |
| 4 | Gas Station policy for `ARC` in the Circle console | Circle console | Desk gas is sponsored; without it the SCA pays gas from its own USDC (the Desk detects and says so) |
| 5 | `make backfill-oracle-v2`, first `postPrint` from the press wallet | the press | a mainnet print exists |
| 6 | `make snapshot` against the mainnet API; Vercel: `NEXT_PUBLIC_ACR_API`, `NEXT_PUBLIC_ACR_CHAIN_ID=5042`, `ACR_API`, `ACR_ARC_RPC_URL` (keyed); **no** `ACR_TERMINAL_BUYER`; deploy | Vercel | the terminal's cold-start bundle is mainnet; the dateline chip says *Arc mainnet* |
| 7 | ~~subgraph~~ **DONE 2026-09-28**: `acr` v1.0.0-mainnet on account `1762718`, indexing from 23013298 with `hasIndexingErrors: false`, and `ACR_SUBGRAPH_URL` set — `/tca/{payer}` answers `available: true`. Published to the gateway as `N69YD8crrap…`; switching to it needs `ACR_GRAPH_API_KEY` | The Graph Studio | TCA reads answer |
| 8 | `make resolve-humans ARGS=--commit` for the current window | the resolver key | `humans.n` is not silently 0 |
| 9 | `make verify-mainnet` then `make verify-live` (its *revenue* section checks the 402, the facilitator's chain list, the public RPC, the balances route) | anyone | all ✓ |
| 10 | Buy one thing yourself from a wallet that had **no** USDC on Arc: bridge → deposit → buy (§3 step 7) | operator, a personal wallet, ~$2 on Base | the five community steps, end to end, before anyone else tries |
| 10a | `PROBE_KEY=0x… SELLER=<mainnet api> make wallet-settle-probe` | a funded Gateway balance | the same settle without a browser, as a one-command regression check. Proven on testnet 2026-09-26: 402 → wallet signature → `success` + Gateway id → data served → **100 atomic USDC debited on chain after ~9 min** (Gateway's batch window) |
| 11 | Paste the first `postPrint` hash and the first receipt into `README.md`; send the link with `COMMUNITY-TEST.md` | operator | launch |

**The guard is your checklist, and it has already run.** Resumed once on 2026-09-26 against the
pinned image, the service refused to start and said why — in production, not in a test:

```
MainnetGuardError: refusing to start on Arc mainnet (chain 5042) — 3 violation(s):
  - ACR_X402_PAY_TO is not an address: paid prints would be paid to nobody
  - ACR_HUMANID_APP_ID is unset: a proof scoped to no app authorizes nothing
  - ACR_ARC_RPC_URL is not a mainnet https endpoint (the public one is https://rpc.mainnet.arc.io…)
```

Exactly three, all of them secrets a repo cannot hold. Everything else in the mainnet profile was
accepted, so that list is the remaining work — when it comes back empty, the service boots. This is
audit finding H1 (both gates fail OPEN in `auto`) verified on the deployed artifact.

A tester's failure lands as a *Mainnet test* issue (`.github/ISSUE_TEMPLATE/mainnet-test.md`).
Read the sentence they pasted first: every path in the terminal fails with one, so a raw code or a
blank is a bug in the terminal even when the cause is elsewhere.
