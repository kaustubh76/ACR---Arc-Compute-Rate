# Arc cut — operator runbook

Three minutes, zero dependency on the World session. Every command is one you
can paste; every line is one you can say. Rehearse it twice before recording.

## Before you start (once, ~15 minutes)

```bash
# 0. Gas. On Arc, gas IS USDC. 20 per request, then a 2-hour lock per asset.
#    https://faucet.circle.com  ->  0x64E21e01e7D9Abfd4C32cfaC4F590B24ECf38d16
cast balance 0x64E21e01e7D9Abfd4C32cfaC4F590B24ECf38d16 --rpc-url https://rpc.testnet.arc.io

# 1. Deploy. One broadcast, the whole set.
cd contracts
DEPLOYER_PRIVATE_KEY=$(cat ../data/float-deployer-key.txt) \
FLOAT_EXECUTOR=0x7FAAC6F8079980c32Eb4aD62f65dFd11715183A0 \
FLOAT_KEEPER=0x3111B1a058AE3ec480A186b21362b0DF85b0f597 \
forge script script/DeployFloat.s.sol \
  --rpc-url https://rpc.testnet.arc.io \
  --private-key $DEPLOYER_PRIVATE_KEY --broadcast --legacy

# 2. Record the addresses where the TS side reads them.
#    Write float/deployments/arc-testnet.json from the script's output.

# 3. Fund the treasury and the two submitting keys, then print.
cd ../float
FLOAT_NET=arc-testnet npm run keeper -- --once
FLOAT_NET=arc-testnet npm run verify          # must be 11/11 before you record

# 4. Bake the addresses into the dashboard's DEFAULTS block and push to Studio.
#    The Studio preview has NO address bar, so a query string cannot be typed in.
arc-studio run "serve the updated index.html" \
  --file app/index.html:index.html --session float-dashboard

# 5. Leave the agents running so the tape has hours of history by morning.
FLOAT_NET=arc-testnet npm run agents
```

**Verify source on the explorer** before recording — judges read the fair-band
check in verified source, and an unverified contract invites the question of
whether the code shown is the code running.

## The cut

| t | you do | you say |
|---|---|---|
| 0:00 | dashboard on the runway panel | "Anyone can park USDC in a yield vault. A treasury only exists if it can *forecast* — and forecasting what an agent will spend needs a live price of compute. We've printed it since September. This agent holds zero." |
| 0:20 | point at the three prints, then at llama-3.3's ±34% | "Nine providers serve this one model between $0.000155 and $0.000783 per thousand tokens. A five-fold disagreement about one product. That's why a fair price is a *band*, and why the treasury carries that spread as margin." |
| 0:45 | `npm run agents -- --once --park 0.5`, then open the paid row's tx on the explorer | "Watch the internal calls in order: the price is read, the exact shortfall comes out of the Morpho vault, the seller is paid, the receipt is written. One transaction. That USDC was earning yield in the previous block." |
| 1:20 | point at the agent EOA on the explorer: 0 USDC | "The agent's own wallet. Zero before, zero after, permanently. It never held a key that could move money — it asked, and the vault decided." |
| 1:40 | the refused row; open its `Denied` event | "Now the same request at three times the rate. Refused, on chain, in English, with the fair counter-price attached. The benchmark is the bouncer." |
| 2:05 | edit `policy.config.json` to freeze waster → `npm run policy` → next agent tick | "The treasurer writes a sentence, not Solidity. One transaction, and the refusal *reason* changes: it was 'quote exceeds ACR fair band', now it's 'agent frozen by policy'. The policy didn't just land — it's what answered." |
| 2:35 | `npm run verify` | "Eleven checks, re-derivable from one command, printing what they observed rather than a tick. Including the one that matters: the sleeve was pulled *before* the seller was paid, proven by log order inside a single transaction — Arc's RPC has no tracing, so this proof works for anyone with an ordinary node." |
| 2:50 | the continuity table | "ETHOnline we built the price of compute. This weekend the price runs the money." |

## Questions you will be asked

**"Portal already has spending limits."** → "Limits cap. Float forecasts, funds
just-in-time, earns yield on the rest, and prices every purchase against a live
benchmark. It sits on top of a limit, not against it."

**"Is the benchmark gameable?"** → "It's a trimmed median of published
per-provider prices with the spread as a confidence interval, and the band is
wider than any rational push. Executed-price feeds are the roadmap — I'm not
claiming them."

**"Your forecaster is one line."** → "Deliberately. Measured spend per hour ×
hours of cover × (1 + provider spread), and with no receipts it says 'no
measured rate' instead of inventing one. The invention isn't the model, it's the
denominator: runway in *compute*."

**"What if the approver key is compromised?"** → "It can release a spend whose
exact hash the vault already opened, inside its TTL, once. It cannot invent a
spend, change an amount, re-aim an approval, or reach past the frozen, band and
cap checks. And it can't be an executor — the contract refuses that."

**"What's actually new versus ETHOnline?"** → the continuity table: 8,383
insertions against 8 deletions, 98.4% in files that didn't exist before.

## If it breaks live

| it breaks | you do |
|---|---|
| RPC flaky mid-demo | the dashboard retries every 12s on its own; keep talking, it comes back |
| a print has gone stale on screen | that's the product working — say so, then `npm run keeper -- --once` |
| the faucet is dry and the treasury is empty | `FloatTestSeller.sweep` returns the demo's money to the vault; no faucet needed |
| a transaction appears to hang | Arc silently drops anything under 20 Gwei `maxFeePerGas` — retry with `--legacy` |
| venue Wi-Fi dies | the recorded cut, which is why it exists |
| you are tempted to add a feature at 3am | the freeze is the freeze |
