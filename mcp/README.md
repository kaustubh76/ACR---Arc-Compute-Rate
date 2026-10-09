# ACR Machine TCA, over MCP

Eleven tools that let an MCP host (Claude Desktop, Claude Code, anything
speaking stdio MCP) ask **whether a bill should be paid**, **whether your agent
has been overpaying**, what compute actually cost a wallet, which seller to
route to, what the tape says — and **whether this agent can pay for a metered
query at all**.

```bash
npx -y acr-mcp          # no clone, no path to edit
```

<details><summary>Or from a clone, which is also how you pin a fork</summary>

`dist/` is gitignored, so a fresh clone has no binary until it builds one:

```bash
git clone https://github.com/kaustubh76/ACR---Arc-Compute-Rate.git
cd ACR---Arc-Compute-Rate/mcp && npm ci && npm run build
```

Then point the host at the built file — `dist/server.js`, never `src/server.ts`,
and an absolute path:

```json
{ "command": "node", "args": ["/abs/path/to/ACR---Arc-Compute-Rate/mcp/dist/server.js"] }
```
</details>

```json
{
  "mcpServers": {
    "acr-tca": {
      "command": "npx",
      "args": ["-y", "acr-mcp"],
      "env": {
        "ACR_API": "https://acr-api-mainnet.onrender.com",
        "ACR_AGENT_PRIVATE_KEY": "0x<any 32-byte key: the card, not a wallet>"
      }
    }
  }
}
```

That is the whole setup. Ten of the eleven tools are reads, so you can paste
this with no wallet anywhere near it. **`ACR_ARC_CHAIN_ID` is deliberately absent** —
the card takes its chain from whichever gate `ACR_API` names, so pointing this at
a different press needs nothing else changed. See *The 401 this used to be* below.

| tool | what it answers | spends? |
|---|---|---|
| **`check_spend`** | **should you pay this bill — the spend agent's own ten-rung ladder over any vendor's invoice, with the published prices it was judged against. No account, no key, no history with ACR** | no |
| **`can_i_pay`** | **can this agent pay for a metered query, and if not, which of seven rungs is in the way** | no |
| **`pay_and_read`** | buys one metered query for real and returns the data plus the settlement reference | **yes** |
| **`payment_receipts`** | did the payment land — the settlement tape and revenue counter, narrowed to your payer | no |
| **`spend_report`** | **the running total of every bill this machine has had checked: how many were over the going rate, by how much in bp, the worst vendor, and what was actually recoverable in USDC. The answer to "is my agent overpaying" for an agent that pays its own vendors** | no |
| `wallet_tca` | a wallet's transaction-cost analysis **if it bought from ACR**: what it paid vs the benchmark, slippage, overpaid. A wallet ACR has never seen comes back `seen: false`, not zero. `"me"` answers the human-proof challenge and returns ONE figure across every wallet the person owns (`ACR_HUMAN_AGENT_KEY`) | no |
| `reroute_suggestion` | the seller this payer should have bought from, and the saving | no |
| `seller_rating` | one seller's rating, components and human depth | no |
| `benchmark_price` | one quote priced against what the market is actually paying | no |
| `get_rate` | the on-chain print for an index | no |
| `query_tape` | any named subgraph operation through the seller's read proxy | no |

## Should I pay this bill?

`check_spend` is the one tool that works on a bill ACR has never seen. Give it the
invoice **as the invoice is written** — the amount billed, how much you bought, and
the unit — and it runs ACR's benchmark and the spend agent's own decision ladder
over it, returning the verdict that agent would reach and the rule that produced it.

```
check_spend(billed_usdc: 0.47, quantity: 23, unit: "$/1k tokens",
            vendor: "0xefe0…dF19")   # vendor optional
```

Three things worth knowing:

- **The bill goes up as billed.** The press divides by the quantity itself, so you
  are never asked to compute the per-unit price the tool exists to check. `quantity`
  is counted *in* the unit: 23 for 23,000 tokens at `$/1k tokens`, not 23000.
- **`vendor` changes the answer, so it is not a label.** A seller ACR operates is
  judged against ACR's own fleet prices; anyone else against the open market. A
  vendor is always excluded from its own comparison set, which can collapse the
  benchmark to "no independent seller" — an answer, not a failure.

  **And it can flip the verdict, which is worth seeing before it surprises you.**
  Measured against a local press: `0.47` for 23 at `$/1k tokens` with no vendor is
  `escalate`, *"500870 bp above the going market rate of 0.0004 across 5 published
  prices"*. The **same bill** naming a fleet seller is `pay` — because excluding
  that seller leaves the fleet population with nobody to compare against, so the
  bill becomes unbenchmarked, and an unbenchmarked bill under the 1 USDC ceiling
  passes. The verdict says so in its own words (*"unbenchmarked but under the
  ceiling"*) and `benchmarked_against` flips `market` → `fleet`, which is why this
  tool returns the press's payload untouched rather than reducing it to a verdict.
  A one-word answer would have hidden the reason the word changed.
- **Three units, and only three** — `$/1k tokens`, `$/GPU-sec`, `$/MB`. The press
  422s anything else and names the list back in its refusal. An earlier version of
  this plugin advertised `$/GPU-hour` and `$/GB-month`; neither exists, so two of
  the three units it offered were an instant 422.

What it does **not** check is named rather than implied: there is no meter, no
counterparty screen, no agreement, no budget and no balance for a caller who has
onboarded nothing, and the verdict leaves a note for each.

## Is my agent overpaying?

`check_spend` answers one bill. `spend_report` answers the question behind it.

Every bill `check_spend` prices is appended to a file on **your** machine, and
`spend_report` folds them into a running view: how many were over the going
rate, by how much, which vendor is worst, and what was actually recoverable.

```
spend_report(days: 30)            # or vendor: "0x…", to narrow it
```

```jsonc
{
  "bills_checked": 41, "priced": 38,
  "over_rate":  { "n": 11, "median_bp": 380, "worst_bp": 4120 },
  "actionable": { "n": 6, "could_have_paid_usdc": 1.84,
                  "basis": "the cheapest reachable independent offer at the time of each check" },
  "by_vendor":  [ { "vendor": "0x…", "bills": 9, "over_rate_bp": 410.2 } ],
  "note": "these are bills you asked ACR to price. ACR did not observe your payments."
}
```

**Why one number is in basis points and the other in dollars.** `par` is the
median of independent observed quotes, so "above the going rate" is a statement
about one price in a market — real, and not money you can go and collect.
`best` is the cheapest offer somebody actually made, so the difference from it
is money that was available. Only the second becomes USDC. ACR's own index
cannot price a real invoice at all: `anchors/GAP.md` puts its reference levels
20x to 1250x off real market prices, which is why none of this is measured
against it.

**And this is a record of checks, not of payments.** ACR never sees whether you
paid any of these bills, at what price, or at all. `wallet_tca` is the other
half — it measures settlements ACR actually observed — and it only works for a
wallet that bought from ACR's own sellers.

## Privacy

**`check_spend` sends each bill to the press.** That is how it gets priced: the
amount, the quantity, the unit and the vendor address go to whatever `ACR_API`
names. That was true before `spend_report` existed and it is worth saying
plainly — if your invoice amounts are sensitive, this is the tool that transmits
them.

**`spend_report` sends nothing.** It reads a plain JSONL file on your machine
and does the arithmetic locally. ACR does not need a copy of your vendor ledger
to tell you what a fair price is, so it does not get one.

| | |
|---|---|
| where | `ACR_SPEND_LOG`, default `~/.acr/spend.jsonl`. The home directory, not the working directory, because an MCP server inherits its host's |
| what | one line per priced bill: vendor, unit, quantity, amount, and the press's verdict. No keys, no cards, no addresses you did not supply |
| who can read it | mode `0600`, created `0700`. Plain JSONL: read it, grep it, `rm` it |
| turning it off | `ACR_SPEND_LOG=off`. Then `check_spend` answers `recorded_to: null` and `spend_report` says there is nothing to report |

There is deliberately **no tool that deletes it**. A tool that erases a
business's bill history is a tool a model will eventually try; `rm` is the
interface.

## Can my agent pay?

This is the question the plugin could not answer for its first version. The six
original tools are analytics over payments that happened somewhere else: none of
them touched a payment-gated endpoint, so a developer who wired the server up
never even saw a 402, and the only way to find out was to leave the agent and
start curling.

`can_i_pay` answers it as a ladder, because "no" is the useless answer. There are
seven independent reasons a payment cannot happen, they fail in a fixed order, and
the one that fired is the only thing you need:

| rung | what it checks |
|---|---|
| `host` | the press answers, and says which chain it is on |
| `chain` | that chain has a profile here, so USDC and the Gateway wallet can be located |
| `card` | the gate **accepts** your agent card — a card it refuses 401s every other tool |
| `gate` | the endpoint really is behind the paywall, per the gate's own `gated_endpoints` |
| `challenge` | the 402 comes back and parses: scheme, network, asset, payTo, amount |
| `payer` | a payer key is configured — the one thing no server can supply for you |
| `funds` | the money is in the **Circle Gateway** balance a settlement spends from |

It never answers the 402 it asks for, so nothing is spent and no key is needed to
run it. With no payer key it still reports the other six rungs, which is the useful
read-only state: *the gate is fine, you are not configured.*

That last rung is the one that surprises people. An x402 settlement on Arc spends
the payer's **Gateway deposit**, not the USDC in its wallet — the client signs an
EIP-3009 authorization against the GatewayWallet. A wallet holding USDC with an
empty Gateway balance cannot pay; it has to deposit first, and `can_i_pay` says
`deposit` rather than `ready`.

### Paying for real

`pay_and_read` is the only tool that moves money, and it is **not registered at
all** unless `ACR_PAYER_PRIVATE_KEY` is set — a tool a host can see is a tool a
model will try.

```json
"env": {
  "ACR_API": "https://acr-api-mainnet.onrender.com",
  "ACR_PAYER_PRIVATE_KEY": "0x<a wallet YOU control, funded into Circle Gateway>",
  "ACR_MAX_SPEND_USDC": "0.01"
}
```

A paid query is **$0.0001**, which is exactly the amount that makes a looping agent
expensive without ever looking alarming. So there is a per-process cap,
`ACR_MAX_SPEND_USDC`, defaulting to one cent; `pay_and_read` prices each call from
the live 402 *before* authorizing anything and refuses past the cap, naming it.
Set it to `0` to keep the tool registered but inert.

Use a key you control. Never a shared or house key — `ACR_PAYER_PRIVATE_KEY` is a
separate variable from the repo's `ACR_BUYER_PRIVATE_KEY` precisely so the two
cannot be picked up by accident.

## It is a carded caller

Every tool's `fetch` is wrapped by `src/card.ts`, the same EIP-712 encoder the buyer
agent uses. With `ACR_AGENT_PRIVATE_KEY` set, every call carries an `AGENT-CARD`
header, and the seller answers from the **carded** tier: a rate-limit budget keyed on
*your* key rather than the host ceiling every anonymous reader behind a proxy shares,
and — on `query_tape` — Google Cloud Model Armor screening the request and the reply.
Unset, the server is anonymous, which is a working state, not an error.

### The 401 this used to be

The chain id lives inside the card's EIP-712 domain, so it is part of the
signature: sign for one chain, present it to a gate expecting another, and the gate
recovers a different address and answers
`401 "agent card signature does not match its agent"`.

`DEFAULT_API` named the mainnet press while the chain id defaulted to Arc testnet,
and nothing — not this README, not the snippet on `/developers` — set the variable
that reconciled them. Measured 2026-10-08 against the config this file used to
print: **four of five tools 401, the fifth failed downstream of it.** All 16 tests
passed, because they fake `fetch`, and a fake gate cannot refuse a card.

So the chain id is not defaulted any more. `GET /agent/challenge` answers an
uncarded caller with its own `chain_id`, and that is what the card is signed for.
`ACR_ARC_CHAIN_ID` still overrides, for a fork or a local gate. And when the chain
cannot be established at all, the call goes out **anonymous** rather than carrying a
card the gate will refuse — a lower rate-limit bucket beats a 401 on every tool.

| env | meaning |
|---|---|
| `ACR_API` | the seller to call (default `https://acr-api-mainnet.onrender.com` — the same host `/developers` renders in its config block) |
| `ACR_AGENT_PRIVATE_KEY` | signs the card. Any 32-byte key; nothing is enrolled, nothing is spent |
| `ACR_PAYER_PRIVATE_KEY` | **spends.** The wallet `pay_and_read` settles from. Unset → that tool is not registered, and `can_i_pay` reports the `payer` rung as the blocker |
| `ACR_MAX_SPEND_USDC` | per-process spend ceiling (default `0.01`). `0` means refuse every payment |
| `ACR_ARC_RPC_URL` | the RPC `can_i_pay` reads balances from (default: the chain's public one) |
| `ACR_AGENT_HUMAN_CLUSTER` | **opt-in** human claim: the cluster `HumanIdMirror.clusterOf` records for this key's wallet in the *current* 7-day window. A claim the chain cannot confirm is a **401**, never a silent downgrade, so leave it unset unless you have resolved that wallet |
| `ACR_ARC_CHAIN_ID` | overrides the card's domain chain. **Leave it unset** unless you know you need it; the gate is asked instead |
| `ACR_SPEND_LOG` | where `check_spend` records each priced bill so `spend_report` can total them. Default `~/.acr/spend.jsonl`; `off` disables recording entirely. Nothing here is uploaded — see **Privacy** |
| `ACR_ARC_PRIVATE_MAINNET` | selects Arc's private mainnet profile for the one path that spends. Leave unset unless you have been told otherwise: it changes which chain a settlement is built for |
| `ACR_HUMAN_AGENT_KEY` | lets `wallet_tca("me")` answer the **AgentKit** gate (production): the key of a wallet registered in AgentBook. The plugin signs each challenge (CAIP-122, EIP-191) in-process; the key never leaves it. A demo buyer's key derives from its public label |
| `ACR_HUMAN_NULLIFIER` | the same, for a local **dev** gate (`ACR_HUMANID_MODE=dev`): a bare nullifier. Not a spending key; anyone holding it can read that human's costs |

The card names no `verifyingContract` on purpose — the seller, not a contract,
verifies it — so `audience` (`acr-index-api`, read from `GET /agent/challenge`) and
a 15-minute lifetime stand in for one. `GET /agent/whoami` with the header tells you
which tier you landed on and why, and `can_i_pay`'s `card` rung reports exactly that.

## Two things to know about the answers

**`benchmark_price` wants a `unit`.** With one, it goes through ACR's `/par`
benchmark and returns the verdict the spend agent itself would reach. Without one,
all it can do is compare against the index print — and an index *level* is not a
dollar price per unit. Asking it to price `$2.50` per GPU-hour against a level of
`0.011` used to return a confident `slippage_bp: 2257157.1`. It now refuses that
comparison and says why.

**The default window is 30 days.** It was 7, and at 7 every payer and seller on
both presses reported zero rows — including the addresses `/developers` printed as
its worked examples. An empty window now carries a `hint` saying it is a window
rather than a verdict.

## Developing

```bash
npm ci && npm test      # 61 hermetic tests, no network, no secrets — what CI runs
npm run typecheck
npm run build           # tsc → dist/, which is what `npx acr-mcp` runs
npm run smoke           # every tool against a REAL press (needs network)
```

`npm run smoke` is the one that matters before publishing. The unit suite fakes
`fetch`, which is the right shape for a hermetic CI job and is why the 401 above
survived 16 green tests — a fake gate cannot refuse a card. The smoke probe reports
the gate's own chain id and the tier it actually granted, so it cannot pass
identically against a press it was never pointed at.

Full design: [`docs/AGENT-MODULE.md`](../docs/AGENT-MODULE.md).
