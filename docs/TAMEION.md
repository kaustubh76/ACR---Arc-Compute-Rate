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

**Where the pages are.** `/spend` and `/traction` exist in `apps/terminal` and are reachable from
the masthead, but **the terminal is not deployed yet** — it is built for Arc mainnet and correctly
refuses a testnet press, which is the guard that exists because a resumed testnet seller once served
testnet data under a mainnet masthead. Until the mainnet press is woken, the honest live surface is
the API above, and these tables link to what actually answers. Run the pages locally with
`make api` and `make terminal`.

## The claim we are not making

*Agents and Ledgers* — the analysis this event asks every team to read — says a
balanced ledger proves almost nothing: *"That equality is the ledger's one
built-in check and nearly every mistake an LLM can make with money passes it."*
It names six, and says the controls that catch them live **outside** the ledger.

So we do not claim the books balance and stop there. `GET /operator/audit/{business}`
searches for all six by their own names, and not one of the checks reads the
ledger alone:

| The error | What we check, and against what |
|---|---|
| omission | the sellers' own settlement tape, for a payment with no decision |
| commission | whether the payee ever served this business at all |
| principle | the registry's declared categories, not the exporter's own mapping |
| original entry | billed against paid, and the retry that pays twice |
| compensating | over- and under-counts that cancel across a period |
| complete reversal | a posting whose direction is inverted and still sums to zero |

And a seventh, reported beside them because it is **not** one of the essay's six:
the **phantom payment** — the fictitious entry the essay says nobody can
disprove, naming SolidInvoice for *"the most complete write path, and no way to
disprove a phantom payment."* We could produce one: on a chain where the budget
contract has no code, a call neither reverts nor fails to estimate, so a
transaction broadcasts, returns `status: 1`, and gets written down as a payment
with a hash as its evidence. The client now refuses to send at all, and the
audit looks for one anyway — a control nobody audits is a control nobody can
show you. Every claimed payment is put back to the chain; a node that cannot
answer is "could not tell", never a finding.

Every check reports **what it searched**, because `found: 0` over nothing
examined is indistinguishable from a clean book. A settlement with no payee is
reported as unattributable rather than counted clean, since it cannot be matched
to any decision either way.

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
| **Who it runs for** | [`GET /operator/traction`](https://acr-api-1fto.onrender.com/operator/traction) — counted from the registry and the decision log at request time |
| **One business's money** | [`GET /operator/statement/acr-fleet`](https://acr-api-1fto.onrender.com/operator/statement/acr-fleet) — the statement, the budgets, and the queue waiting on its owner |
| **The ledger** | `GET /operator/ledger/{business}` — beancount, every transaction summing to zero, and a closing `balance` assertion with a declared tolerance. Each `/traction` row links to its own, as a download |
| **What the ledger cannot check** | `GET /operator/audit/{business}` — the six errors a trial balance cannot see, searched for by name. Rendered at the foot of `/spend` |
| **Prove it** | `make verify-operator` — every honesty property above, re-checked against a live deployment, including whether the queue can actually be cleared. Some checks are conditional on what the deployment has, so it reports the count it ran rather than promising one |

**Stated plainly, because a reviewer will check.** The loop runs on **Arc
testnet**, where the fleet's real settlement history gives the meter genuine
consumption to count. Those settlements **predate the window** — what is
in-window is the onboarding and every decision since.

The operator now spends. `PolicyWallet`
[`0xA755f87BD00c90DBFc9DdfD6651e4c3071665b32`](https://testnet.arcscan.app/address/0xA755f87BD00c90DBFc9DdfD6651e4c3071665b32)
holds the fleet's USDC under a 1 USDC cap with a 0.05 USDC per-payment limit.
A live run paid five obligations, rerouted three to cheaper sellers, and
escalated the one bill at or above that limit; the owner settled it with
`spendAsOwner`, from a different key, because the contract refuses an approval
signed by the thing being approved. The contract's own `spent` figure and the
decision log agree.

Everything here is **test USDC on Arc testnet**. Canteen say test USDC counts
and real USDC on mainnet counts for more; the two are reported apart, never
summed, and `moved_usdc` is what was actually paid rather than what was
assessed — `priced_usdc` is the second number, and collapsing them would be the
most tempting lie available on a traction page.

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
