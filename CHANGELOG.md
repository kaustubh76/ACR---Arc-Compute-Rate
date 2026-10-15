# Changelog

Notable changes to ACR, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Packages are versioned
independently with [Semantic Versioning](https://semver.org/) and tagged
`<package>@<version>`. Milestones carry their own tags, so every entry below can
be checked out exactly.

## [Unreleased]

### Added
- **Chain toggle.** One terminal deployment serves either Arc network per request,
  with every response stamped with the chain that answered.
- **`check_spend`, `spend_report`, `can_i_pay`** in the MCP server: a verdict on
  any vendor's invoice, a running total of every bill priced, and a dry-run answer
  to "can this agent pay" that names the blocking rung.
- **Mainnet subgraph** `acr` deployed to Subgraph Studio and published to The Graph
  network, so mainnet reads go through the gateway.

### Fixed
- The terminal no longer caches a fallback response as if it were a live answer.
- Every surface that shows a print now says how old it is, and a stale print can
  no longer flash as LIVE during hydration.
- The `mcp` CI job, which had never concluded, now finishes inside its time cap.

## acr-mcp 0.3.1 — 2026-10-11

### Changed
- Defaults to the mainnet press whose subgraph answers.

## acr-mcp 0.3.0 — 2026-10-10

### Added
- First release on npm: `npx -y acr-mcp`. Eleven tools for any MCP host, ten
  reads and one paid query that registers only when a payer key is set.
- A running Machine TCA an outside agent can keep on itself (`wallet_tca`).

## Tameion spend operator — 2026-09-27 to 2026-10-10

The work from tag [`tameion-baseline`] onward. Full write-up in
[`docs/TAMEION.md`](docs/TAMEION.md).

### Added
- **The operator.** An agent that holds a business's USDC inside an on-chain
  budget (`PolicyWallet`), meters consumption, benchmarks each price, screens the
  counterparty, checks the wallet's cash, pays what clears policy and escalates
  the rest to the owner's own wallet.
- **PAR** (`GET /par`) and the `/check` page: one invoice priced against
  published list prices from sellers ACR does not operate, each row citing its source.
- **Books a human can open.** An owner-facing statement, a beancount ledger where
  every transaction sums to zero, and an audit for the six errors a trial balance
  cannot see.
- **`/traction`**, counted from the registry and decision log at request time.
- **`make verify-drift`**, which diffs the deployed API against the code in both
  directions.

## [Arc mainnet launch] — 2026-09-27

### Added
- Seven contracts deployed to Arc mainnet (chain `5042`) in one broadcast for
  0.157348 USDC of gas: `ACROracle`, `ACROracleV2`, `ACRFutures`,
  `AttestationRegistry`, `ReceiptMirror`, `HumanIdMirror`, `FeedAccessAttestor`.
  The deploy key's signer bit was revoked on every contract in the same transaction.
- The first three prints (ACR-INF, ACR-GPU, ACR-DATA) posted and read back through
  `/onchain/{index}`.
- On mainnet, a misconfigured payment gate refuses to boot rather than serving free.
- A visitor can buy with their own wallet, bridging USDC onto Arc with Circle's
  Bridge Kit over CCTP.

### Changed
- Node 24 everywhere; Node 20 reached end of life in April.
- Terminal upgraded from Next.js 14 to 16, with linting enabled for the first time.

## [ETHOnline 2026] — 2026-09-13

### Added
- **Machine TCA on The Graph.** Every x402 settlement is benchmarked inside the
  subgraph mapping against the print the payer could have seen.
- **Human-denominated manipulation cost via World ID.** `HumanIdMirror` and a
  `humanAdjustedBound` published beside the wallet-denominated attack cost.
- **Agent cards and tiers** (`anonymous`, `carded`, `human`), stamped on every receipt.
- **`/loop`**: the reroute, Model Armor screening and proof of personhood, drivable
  from the browser.
- The first MCP tools over the tape.

## [1.0] — 2026-08-10

The Arc × Circle Agentic Economy submission, on Arc testnet.

### Added
- The four-pillar estimator: batching deconvolution, hedonic adjustment, a
  manipulation bound, and a cash-settled future with an Avellaneda–Stoikov maker.
- Hourly EIP-712 prints signed by a Circle custody wallet and posted to `ACROracle`.
- The x402-gated seller API and the autonomous hedger that pays for a print and
  trades on it.
- The ACR Terminal, including the Plain Edition and the "Attack the Index" demo.
- CI-gated headline result: naive VWAP dragged > 100 % under the paired attack,
  ACR < 3 %.

[Unreleased]: https://github.com/kaustubh76/ACR---Arc-Compute-Rate/compare/acr-mcp@0.3.1...HEAD
[`tameion-baseline`]: https://github.com/kaustubh76/ACR---Arc-Compute-Rate/tree/tameion-baseline
[Arc mainnet launch]: https://github.com/kaustubh76/ACR---Arc-Compute-Rate/releases/tag/mainnet-2026-09-27
[ETHOnline 2026]: https://github.com/kaustubh76/ACR---Arc-Compute-Rate/tree/ethonline-2026
[1.0]: https://github.com/kaustubh76/ACR---Arc-Compute-Rate/releases/tag/v1.0-submission
