---
name: acr-hedge
description: Hedge compute-price risk on Arc using ACR — discover the priced index feeds, pay for a print with a Circle agent wallet (x402 nanopayment), read the futures venue, and take or adjust a position. Use when an agent needs to buy the ACR-INF / ACR-GPU / ACR-DATA rate, hedge inference or GPU or data costs, or trade ACRFutures. Triggers on: hedge compute costs, buy a compute price print, ACR, Arc Compute Rate, compute futures.
---

# Hedge compute costs with ACR

ACR (Arc Compute Rate) publishes a manipulation-resistant benchmark for machine-service
prices — ACR-INF ($/1k tokens), ACR-GPU ($/GPU-sec), ACR-DATA ($/MB) — pressed hourly
on-chain on Arc Testnet (chain 5042002), with a cash-settled weekly futures venue that
settles only against a print less than two hours old. This skill is the loop the
reference agent runs: **pay for the print, then trade on it — and because the venue
fills every trade at that same print, the position you end up holding is the print you
bought.** One wallet buys both legs; one URL shows both.

Reference implementation: `scripts/hedger.py` in the ACR repo. That URL is
`GET https://acr-api-1fto.onrender.com/hedger`, and it is the point of the design: it
returns the Gateway settlements the agent's own wallet paid **and** the position and
fills those prints bought, so the loop is checkable by a stranger rather than attested
by the agent.

## Prerequisites

A Circle agent wallet with the `circle` CLI (`npx -y @circle-fin/cli@latest`), logged
in (`circle wallet login --testnet`), holding USDC on ARC-TESTNET — USDC is Arc's
native gas, so one balance pays for data, margin, and gas. The Circle skills
(`circle skill install --tool claude-code`) cover wallet setup and funding.

## Step 1 — Discover

The catalog is free; only the data costs money.

```bash
curl -s https://acr-api-1fto.onrender.com/marketplace/catalog   # 13 priced resources, x402 accepts[]
curl -s https://acr-api-1fto.onrender.com/x402/info             # the gate: facilitator, price, payTo
```

Or through the marketplace tooling: `circle services search compute`.

## Step 2 — Pay for the print (x402 nanopayment via Gateway)

```bash
export NODE_OPTIONS="--experimental-global-webcrypto"
circle services pay https://acr-api-1fto.onrender.com/prints/ACR-INF \
  --address <AGENT_ADDRESS> --chain ARC-TESTNET --max-amount 0.0002 --estimate
# then the same command without --estimate to actually pay (~0.0001 USDC)
```

`NODE_OPTIONS=--experimental-global-webcrypto` is REQUIRED for `services pay`: without
it the CLI dies inside Gateway batched-payment signing with "Could not sign payment
authorization", which reads like a wallet problem but is a missing Node global.
(`circle wallet execute` is unaffected — only the payment leg.)

The response body carries the print: value, confidence interval, attack-cost-per-bp,
and timestamp. Trust the seller's stated price (`amountPaid`), not your guess.

## Step 3 — Read the venue

```bash
curl -s https://acr-api-1fto.onrender.com/futures   # per-index series: id, mark, margin bps, expiry, open interest
```

ACRFutures: `0x29d97c629a8278f7ec4218ab0bd8baa9182642fe` (testnet.arcscan.app). Every
fill takes the oracle mark; the designated maker mirrors your side; 20% initial margin;
settlement refuses a print older than 2 hours.

## Step 4 — Hedge

Approve and post collateral (USDC amounts are 6-decimals integers), then trade:

```bash
circle wallet execute "approve(address,uint256)" 0x29d97c629a8278f7ec4218ab0bd8baa9182642fe <usdc6> \
  --contract 0x3600000000000000000000000000000000000000 --address <AGENT_ADDRESS> --chain ARC-TESTNET

circle wallet execute "postCollateral(uint256,uint256)" <seriesId> <usdc6> \
  --contract 0x29d97c629a8278f7ec4218ab0bd8baa9182642fe --address <AGENT_ADDRESS> --chain ARC-TESTNET

circle wallet execute "trade(uint256,int256)" <seriesId> <qtyWad> \
  --contract 0x29d97c629a8278f7ec4218ab0bd8baa9182642fe --address <AGENT_ADDRESS> --chain ARC-TESTNET
```

**Quantity is WAD-scaled and MUST be an integer string**: `str(int(round(qty * 10**18)))`.
A float reaches the CLI in scientific notation for small sizes and gets ABI-encoded as
something nobody intended. Positive = long (pays if the rate rises), negative = short.

> **A negative `int256` does not survive `circle wallet execute` today.** Measured on
> 2026-08-08 against ARC-TESTNET: `trade(uint256,int256)` with `+1e16` estimates fine and
> returns a fee, while `-1e16` fails with `400 Fails to perform transaction estimation`.
> Two's complement, as hex or decimal, fails the same way, and `--` before the positional
> arguments does not help. It is **not** a contract revert — the same call succeeds under
> `eth_call` against the venue, and an oversized *positive* quantity returns the different
> error `Estimate fee execution reverted`, which is what a real revert looks like. So the
> failure is in building the transaction, not in running it.
>
> Practical consequence: **an agent on this path can open and increase a position but
> cannot reduce one.** Design for it. Either give your agent a one-directional mandate,
> keep an EOA route for the closing leg, or let the position run to cash settlement at
> expiry — and whichever you choose, do not write an agent whose mandate assumes it can
> trade back. Ours did, and it sat 0.47 contracts above its target with no way down.

## Guardrails the reference agent enforces (copy them)

- **Spend cap on data**: pass `--max-amount` so the payment layer refuses independently
  of your own accounting.
- **Margin-bound vs book-full are opposite diagnoses.** If YOUR collateral term binds,
  post more and trade — an agent with a mandate it can reach and does not is not much
  of an agent. If the MAKER's term binds, the book is full: posting collateral spends
  money and still cannot trade. Refuse, and say so accurately.
- **Re-read collateral after posting.** A transaction that returned is not collateral
  posted; sizing a trade off the number you hoped for is how an agent authorizes an
  order the contract then reverts.
- **A breach refuses rather than clamps**, and log the whole decision rather than the
  outcome. "It traded" is an assertion; "it held 2.00 against a mandate of 2.5 at a mark
  of 0.49236, so it bought 0.47" is a claim someone can check.
- **Publish state, not a log file — and know which leg settles where.** Your two legs do
  not settle in the same place, and conflating them is the easiest false claim to make
  here. The *trade* is an Arc transaction and an `ACRFutures.Traded` event, so an explorer
  resolves it. The *payment* is a Circle Gateway batch settlement: an off-chain UUID that
  no explorer can resolve, which is exactly why the seller publishes a receipts tape at
  all. So serve both from one public endpoint instead of pointing at a file on your own
  disk — a log on the machine that ran the agent proves nothing to anyone else, and ours
  had a null payment reference for its first seven live decisions without anybody
  noticing. The reference agent's endpoint is `GET /hedger` above: the Gateway `tx_ref`s
  its wallet settled, and the position and fills those prints bought, each derived from a
  source the reader can hit without you.
