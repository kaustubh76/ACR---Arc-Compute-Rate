# Tameion — the spend operator

*Canteen × Circle × Arc, 27 September – 10 October 2026. This file is maintained
during the event; the frozen material from earlier events lives in
[`hackathon/`](../hackathon/).*

ACR is a reference rate for machine compute. The Tameion build puts a **spend
operator** on top of it: an agent that holds a business's USDC inside an
on-chain budget it cannot exceed, meters what was actually consumed, checks
every price against what other sellers are really charging, screens the
counterparty, pays what clears policy, escalates what is not its call, and
writes a double-entry ledger a human can open.

## The delta, computed rather than asserted

FAQ Q6 judges the gap: *"where was the product and how many users did it have
when Tameion began, and where are both at the end?"* So the window's start is a
tag, not a claim:

```bash
git diff tameion-baseline..HEAD --stat     # what changed
git log --oneline tameion-baseline..HEAD   # and why, one commit at a time
```

At the baseline ACR was live on Arc mainnet with the benchmark, the public tape,
the TCA engine and signed decision receipts — and **zero businesses**. The
operator, the registry, the statement, the ledger and the traction page are all
new in the window.

## What is live, and what is not

| | |
|---|---|
| **Who it runs for** | [`/traction`](https://arc-compute-rate.vercel.app/traction) — counted from the registry and the decision log at request time |
| **One business's money** | [`/spend`](https://arc-compute-rate.vercel.app/spend) — the statement, the budgets, and the queue waiting on its owner |
| **The ledger** | `GET /operator/ledger/{business}` — beancount, every transaction summing to zero |
| **Prove it** | `make verify-operator` — fifteen checks against a deployment, including the honesty properties |

**Stated plainly, because a reviewer will check.** The loop runs on **Arc
testnet**, where the fleet's real settlement history gives the meter genuine
consumption to count. Those settlements **predate the window** — what is
in-window is the onboarding and every decision since. No `PolicyWallet` is
funded yet, so the operator prices and meters and has **moved nothing**:
`moved_usdc` is zero on the traction page and reported as zero. Canteen say test
USDC counts and real USDC on mainnet counts for more; both numbers are kept
apart and neither is inflated.

## The four decisions worth arguing with

**PAR is observed quotes, never the published index.**
[`anchors/GAP.md`](../anchors/GAP.md) records this project's own index reference
levels sitting 20× to 1159× away from real market prices, deliberately frozen
because they seed the simulator and the tape's price pin. Measuring a real
vendor's bill against that print reads as a ~9,990 bp discount on an invoice
that is in fact above the going rate. So the benchmark is built from prices we
watched somebody offer or accept for the same service, at the same **unit** —
measured on our own tape, no resource has more than one seller, while `$/1k
tokens` has four spanning 1.3×. The index survives on the statement only as
basis points, labelled, because bp is scale-invariant and dollars are not.

**The budget is a contract, and the threshold is a key.** `PolicyWallet` holds
the USDC: per-category caps, a per-transaction limit, and refusal rather than
clamping. Above the limit the agent's `spend` reverts and the only path is
`spendAsOwner`, which the contract gates on `msg.sender == owner` — the owner's
own wallet sends the transaction. Not a signature the agent relays and not a
flag in a database. `ecrecover` cannot check a smart-contract account
([`WALLETS.md`](WALLETS.md) C1), so a Circle PIN-secured wallet could never
clear a signature path; calling the contract needs no signature scheme at all,
and nothing can go stale between deciding and paying.

**A screen that cannot answer is never "clear".** Counterparty risk has three
states, and the middle one is the point: `unknown` is not `clear`, because a
screening service that times out must not read as a clean bill of health. An
unknown does not stop the business by default — it is recorded on every
decision — and `ACR_SCREEN_REQUIRED=1` turns it into an escalation.

**The ledger carries what a ledger misses.** *Agents and Ledgers* opens: a
ledger checks that debits equal credits, not that the vendor was right, the
invoice real, or the retry unpaid twice. Every transaction here is annotated
with the rule that fired, what we independently metered, the par it was checked
against, what the screen said, and the hash the chain holds. A reroute moved no
money, so it is a note and not a transaction: booking an avoided overpay as
income would be inventing a credit in the format that makes it look official.

## Running it

```bash
make operator-run BUSINESS=acr-fleet        # dry run: price, meter, decide
make ledger BUSINESS=acr-fleet              # the beancount file
make verify-operator                        # prove a deployment
```

`--live` is refused for a business with no `PolicyWallet` rather than doing a dry
run under the wrong name.
