## What and why

<!-- One paragraph: what changed, and what was wrong or missing before. -->

## How it was verified

<!-- Against the live deployment where it matters, not only against a mock. Paste the command and its output. -->

## Checklist

- [ ] `make ci` passes locally, or the jobs this touches do (`python`, `contracts`, `agent`, `terminal`, `subgraph`, `mcp`)
- [ ] Test counts changed? The README is updated and `python scripts/verify_claims.py` reports nothing stale
- [ ] Touches `apps/terminal/`? `mainnetOnly.test.ts` still passes (no Arc testnet literal in shipping code)
- [ ] Touches a contract? `forge test` passes, including the invariant suites
- [ ] No key, `.env` value or `data/` file in the diff
