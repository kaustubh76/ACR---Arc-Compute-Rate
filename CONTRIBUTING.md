# Contributing to ACR

ACR is a live reference rate on Arc mainnet. It prints real numbers, signs them,
and puts them on chain. A change here can move a published figure, so the bar is
*measured, not asserted*. This guide is short so you will actually read it.

## Set up

Prerequisites: Python ≥ 3.11 with [uv](https://docs.astral.sh/uv/),
[Foundry](https://book.getfoundry.sh/) (`forge`), and Node 24 (see `.nvmrc`).

```bash
make setup        # uv sync --all-packages · forge install · npm install
make test         # pytest + forge + agent + terminal
make ci           # exactly what CI runs: lint + tests + the eval gate
```

Everything runs **credential-free**. With no Circle or Arc keys set, the tape
falls back to the calibrated simulator and the whole suite still passes.
Never commit a key. `.env`, `data/` and the strategy documents listed in
`.gitignore` stay out of the repository on purpose.

## Where things live

| Path | Stack | Gate |
|---|---|---|
| `packages/`, `services/` | Python (uv workspace) | `uv run pytest`, `uv run ruff check .` |
| `contracts/` | Solidity 0.8.24, Foundry | `forge test` (unit + invariant) |
| `apps/terminal/` | Next.js | `npm test`, `npm run build` |
| `apps/agent/` | TypeScript | `npm test` |
| `graph/` | The Graph subgraph | `npm test` (matchstick) |
| `mcp/` | MCP server, published as `acr-mcp` | `npm test`, `npm run smoke` |

## Rules CI enforces, so you do not find out the hard way

- **The README's numbers are audited.** `scripts/verify_claims.py` re-measures
  every count the README quotes (test suites, CI jobs, receipts, contract
  addresses) and fails the build when they disagree. If your change adds tests,
  update the count in the README in the same commit.
- **No testnet value in the shipping terminal.** `apps/terminal/lib/mainnetOnly.test.ts`
  fails on any Arc testnet literal under `app/`, `components/` or `lib/`, comments
  included. Route chain-specific values through the chain profile instead.
- **A skipped on-chain test is a failure.** CI stands up a local anvil and fails
  if the on-chain suites skip, because a skip looks exactly like a pass.
- **The eval gate pins the headline result.** `make eval-gate` must still show
  naive VWAP dragged > 100 % and ACR moving < 3 % under the paired attack.

## Commits and pull requests

Commit messages follow the style already in the log:

```
type(scope): one lowercase sentence that says what changed and why it matters
```

Types in use: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `perf`, `ci`.
Scopes name the surface: `terminal`, `mcp`, `graph`, `operator`, `contracts`, `ops`…

Open a pull request against `main`. The template asks which gates you ran.
Keep one concern per PR, and say in the description what you verified against
the live deployment rather than against a mock.

## Releases and tags

Milestones and packages are tagged so any state can be checked out exactly:

| Tag pattern | Meaning |
|---|---|
| `<package>@<semver>` | a package release, e.g. `acr-mcp@0.3.1` |
| `mainnet-YYYY-MM-DD` | an on-chain deployment |
| `v1.0-submission`, `ethonline-2026`, `tameion-baseline` | hackathon snapshots |

To release `acr-mcp`: bump `mcp/package.json`, then from `mcp/` run
`npm run release` (it runs the live smoke test, then publishes), then tag the
commit `acr-mcp@x.y.z` and add an entry to [`CHANGELOG.md`](CHANGELOG.md).

## Security

Do not open a public issue for a vulnerability. Follow [`SECURITY.md`](SECURITY.md).

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
