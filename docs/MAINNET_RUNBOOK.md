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
export DEPLOYER_PRIVATE_KEY=0x...                 # funded with >= 1 USDC for gas
export ACR_HUMANID_SALT_COMMITMENT=0x...          # keccak of the salt — the SALT itself never leaves the operator's machine
make deploy-mainnet-dry                           # five simulations; exits 1 on a wrong chain id
```

The dry run is the gate. If any script fails to simulate, nothing is broadcast and the fix is made
here, not on chain.

## 2 · Deploy, in this order

```sh
make deploy-mainnet
```

which runs, each printing what to set before the next:

1. `Deploy.s.sol` → **ACROracle (v1) · AttestationRegistry · ACRFutures** — the venue settles against v1 and its oracle pointer is immutable, so v1 comes first and stays.
2. `DeployOracleV2.s.sol` → **ACROracleV2** — additional, never a replacement. Then `make backfill-oracle-v2` BEFORE any live post.
3. `DeployReceiptMirror.s.sol` → **ReceiptMirror** — the settlement tape's chain-side record.
4. `DeployHumanIdMirror.s.sol` → **HumanIdMirror** (constructed with the salt commitment) — the human tier's source of truth.

`DeployAttestor.s.sol` (FeedAccessAttestor) is optional and independent; deploy it if the
seller-attestation demo is wanted on mainnet.

## 3 · After the addresses exist

1. **Configuration.** Add a mainnet profile to `render.yaml` (the testnet block stays; the two
   differ in `ACR_ARC_RPC_URL`, `ACR_ARC_CHAIN_ID`, the six contract addresses, `ACR_USDC_ADDRESS`).
   Production runs ONE chain; the Terminal's `NEXT_PUBLIC_ACR_CHAIN_ID` follows it.
2. **Subgraph.** `graph/subgraph.yaml`: network `arc`, each data source's `startBlock` = its
   deploy block; `make graph-deploy VERSION=v1.0.0-mainnet`. The Graph's registry lists `arc`
   as a Studio target (verified 2026-09-01, `docs/SPIKE-LOG.md`).
3. **Humans.** `make resolve-humans ARGS=--commit` for the current rotation window BEFORE any
   tape is generated, or the first week's settlements carry `human: false` forever.
4. **Signers.** Authorise the poster on v1 and v2, the mirror signer on ReceiptMirror, the
   resolver on HumanIdMirror — each script prints the `authorized signer` it set.
5. **Prove it.** `make verify-testnet` reads whatever chain `ACR_ARC_RPC_URL` names;
   `ACR_ARC_RPC_URL=$ACR_MAINNET_RPC_URL make verify-testnet`, then `make verify-live` against
   the redeployed API. Paste the first `postPrint` transaction hash into `README.md` and this file.

## 4 · What does not move on day one

- **The futures venue opens with the demo maker only.** Real liquidity is a listing decision, not
  a deploy step.
- **The seller fleet stays on testnet** until real sellers exist; mainnet TCA begins with the
  first real x402 settlement to ReceiptMirror.
- **No funds are bridged by this runbook.** Gas is the only USDC it spends.
