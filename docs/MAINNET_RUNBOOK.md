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
| RPC | `https://rpc.testnet.arc.network` | set `ACR_MAINNET_RPC_URL` from Arc's published endpoint |
| USDC | `0x3600…0000` (native) — **defaulted** in the scripts | **not defaulted**: `ACR_MAINNET_USDC` is required, so a testnet constant cannot ride onto mainnet by omission |
| explorer | `testnet.arcscan.app` | `arcscan.app` (`apps/terminal/lib/chain.ts` keys on chain id) |
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

1. **Configuration.** Add a mainnet profile to `render.yaml` (the testnet block stays; the two
   differ in `ACR_ARC_RPC_URL`, `ACR_ARC_CHAIN_ID`, the six contract addresses, `ACR_USDC_ADDRESS`).
   Production runs ONE chain; the Terminal's `NEXT_PUBLIC_ACR_CHAIN_ID` follows it.
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
   Then `make verify-live` against the redeployed API. Paste the first `postPrint`
   transaction hash into `README.md` and this file.

## 4 · What does not move on day one

- **The futures venue opens with the demo maker only.** Real liquidity is a listing decision, not
  a deploy step.
- **The seller fleet stays on testnet** until real sellers exist; mainnet TCA begins with the
  first real x402 settlement to ReceiptMirror.
- **No funds are bridged by this runbook.** Gas is the only USDC it spends.
