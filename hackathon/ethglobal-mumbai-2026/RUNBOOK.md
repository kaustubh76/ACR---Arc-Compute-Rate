# Arc cut — operator runbook

Three minutes, zero dependency on the World session. Every command is one you
can paste; every line is one you can say. Rehearse it twice before recording.

## Before you start (once, ~20 minutes)

Every flag below is there for a reason that cost something to learn. The script
has been dry-run against real Arc — `SIMULATION COMPLETE`, 8,687,035 gas — so
this sequence is rehearsed, not hoped for.

```bash
# 0. GAS. On Arc, gas IS USDC. The public faucet is the only source: Arc
#    Studio's own faucet tool refuses without DEVELOPER_ADMIN_DEFAULT_ROLE,
#    which this account does not have.
#    https://faucet.circle.com  ->  0x64E21e01e7D9Abfd4C32cfaC4F590B24ECf38d16
#    20 USDC, then a 2-hour lock per asset. Budget: ~0.2-0.5 for the deploy,
#    >=5 for the treasury, ~7 for an overnight tape.
cast balance 0x64E21e01e7D9Abfd4C32cfaC4F590B24ECf38d16 --rpc-url https://rpc.testnet.arc.io

# 1. BUILD FIRST. contracts/out goes stale and the script would deploy the
#    old bytecode without saying so.
cd contracts && forge build

# 2. DRY RUN. Free, and it proves the five roles resolve to addresses we hold.
#    Defaulted, approver/registrar/studio can silently become DEFAULT_SENDER
#    while `owner` still looks right — registerGuest then reverts "not
#    registrar" forever. They are required now, so a miss fails here.
export FLOAT_EXECUTOR=0x7FAAC6F8079980c32Eb4aD62f65dFd11715183A0
export FLOAT_KEEPER=0x3111B1a058AE3ec480A186b21362b0DF85b0f597
export FLOAT_APPROVER=0x64E21e01e7D9Abfd4C32cfaC4F590B24ECf38d16
export FLOAT_REGISTRAR=0x64E21e01e7D9Abfd4C32cfaC4F590B24ECf38d16
export FLOAT_STUDIO=0x64E21e01e7D9Abfd4C32cfaC4F590B24ECf38d16
export DEPLOYER=0x64E21e01e7D9Abfd4C32cfaC4F590B24ECf38d16
forge script script/DeployFloat.s.sol --rpc-url https://rpc.testnet.arc.io --sender $DEPLOYER

# 3. BROADCAST. Type-2, NOT --legacy.
#    --legacy pays the full gas price with no refund (~3x); type-2 charges
#      base+priority regardless of the cap, and this repo's own broadcast
#      records show seven successful Arc deploys, all type-2.
#    --with-gas-price is the BROADCAST flag. --gas-price configures the
#      simulation EVM and would be a silent no-op here.
#    --slow because ten transactions go out on sequential nonces and wire()
#      is ONE-SHOT: a half-wired vault is the worst available outcome.
#      Recover with --resume, never by re-running from the top.
forge script script/DeployFloat.s.sol --rpc-url https://rpc.testnet.arc.io \
  --sender $DEPLOYER --private-key $(cat ../data/float-deployer-key.txt) \
  --with-gas-price 60gwei --priority-gas-price 2gwei --slow --broadcast

# 4. RECORD. The script prints a paste-ready block. Copy it verbatim into
#    float/deployments/arc-testnet.json — do not retype it. Thirteen fields,
#    and a typo breaks every binary below AFTER the money is spent.

# 5. FUND THE TREASURY with an ERC-20 transfer, never --value. Arc's USDC at
#    0x3600 is the same ledger as gas, so a value send looks right and
#    REVERTS: none of these contracts has a receive().
cast send 0x3600000000000000000000000000000000000000 'transfer(address,uint256)' \
  <VAULT> 8000000 --rpc-url https://rpc.testnet.arc.io --private-key $(cat ../data/float-deployer-key.txt)
#    The executor and keeper need their own gas to submit and to print:
cast send <EXECUTOR> --value 2ether --rpc-url ... --private-key ...   # EOAs, so --value is fine
cast send <KEEPER>   --value 2ether --rpc-url ... --private-key ...

# 6. PRINT, then VERIFY. 11/11 before anything is recorded.
cd ../float
FLOAT_NET=arc-testnet npm run keeper -- --once
FLOAT_NET=arc-testnet npm run verify

# 7. VERIFY SOURCES on Blockscout, separately — not with --verify on a
#    one-shot broadcast. Judges read the fair-band check in verified source.
cd ../contracts
forge verify-contract <VAULT> src/float/FloatVault.sol:FloatVault --chain-id 5042002 \
  --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/ \
  --compiler-version v0.8.24+commit.e11b9ed9 \
  --constructor-args $(cast abi-encode 'c(address,address,uint256)' \
     0x3600000000000000000000000000000000000000 <STORE> 2000000) --watch

# 8. DASHBOARD. Bake the addresses into the DEFAULTS block in
#    float/app/index.html, then push it to Studio. The preview panel has no
#    address bar, so a query string cannot be typed there.
cd ../float && arc-studio run "serve the updated index.html, change nothing else" \
  --file app/index.html:index.html --session float-dashboard

# 9. OVERNIGHT TAPE. Before leaving it: raise scout's cap (at a 60s tick the
#    25 USDC cap is exhausted in ~14 minutes and then emits ~1,400 identical
#    refusals burning ~7 USDC), lengthen TICK_MS, and sweep the seller back.
FLOAT_NET=arc-testnet npm run agents
```

**Do NOT call `setTreasurerBinding`.** It is one-shot from zero and `onlyOwner`.
A placeholder there permanently kills the human-approval path, and the only
remedy is a redeploy. It is set last, with the value the World session's
enrollment prints, after a dry run proves the digest round-trips.

## The cut

| t | you do | you say |
|---|---|---|
| 0:00 | dashboard on the runway panel | "Anyone can park USDC in a yield vault. A treasury only exists if it can *forecast* — and forecasting what an agent will spend needs a live price of compute. We've printed it since September. This agent holds zero." |
| 0:20 | point at the three prints, then at llama-3.3's ±34% | "Nine providers serve this one model between $0.000155 and $0.000783 per thousand tokens. A five-fold disagreement about one product. That's why a fair price is a *band*, and why the treasury carries that spread as margin." |
| 0:45 | `npm run agents -- --once --park 0.5`, then click **four steps** on the paid row — the walkthrough Arc Studio wrote | "The price is read, the exact shortfall comes out of the Morpho vault, the seller is paid, the receipt is written. One transaction. That USDC was earning yield in the previous block." |
| 1:00 | stay on step 2 and read the two numbers out loud | "It pulled fifty-five cents against a dollar-five payment, because fifty cents was already liquid. It pulls the *shortfall*, not the payment — that's the difference between just-in-time funding and keeping your money somewhere else. Log 28, then log 30. Arc has no transaction tracing, so the order of the logs *is* the proof, and anyone with an ordinary node can check it." |
| 1:25 | point at the agent EOA on the explorer: 0 USDC | "The agent's own wallet. Zero before, zero after, permanently. It never held a key that could move money — it asked, and the vault decided." |
| 1:45 | the refused row; open its `Denied` event | "Now the same request at three times the rate. Refused, on chain, in English, with the fair counter-price attached. The benchmark is the bouncer." |
| 2:10 | edit `policy.config.json` to freeze waster → `npm run policy` → next agent tick | "The treasurer writes a sentence, not Solidity. One transaction, and the refusal *reason* changes: it was 'quote exceeds ACR fair band', now it's 'agent frozen by policy'. The policy didn't just land — it's what answered." |
| 2:40 | `npm run verify` | "Thirteen checks, re-derivable from one command, printing what they observed rather than a tick. Including the one that matters: the sleeve was pulled *before* the seller was paid, proven by log order inside a single transaction — Arc's RPC has no tracing, so this proof works for anyone with an ordinary node." |
| 2:55 | the continuity table | "ETHOnline we built the price of compute. This weekend the price runs the money." |

### Arc Studio has to be visible, and the honest way to show it is its own work

Two of the three pages on screen were written by Arc Studio, so say which:
`walk.html` at 0:45 and `venue.html` if you open it. The line that lands is the
one Studio found and we did not ask for — *"no timelock on 4 of the 4 gate
setters"* on the Morpho vault our float sits in, which its `morpho` onchain
skill got by reading the verified Vault V2 source.

If there is room, open the workspace itself at
`studio.arc.io/app/b5aa43e1-4d5c-4d47-b079-dcc9aea0e557` and show the **trace
panel**, which lines up what the page asked for against what happened on chain.
Skip it rather than rush it — the pages are the evidence, the workspace is
provenance.

**Do not claim Studio built Float.** It compiled the policy from English,
audited the vault and wrote those two pages. It did NOT deploy the contracts
(`arc-studio deployments` answers "No deployed contracts found"); that was
`forge script` from our own deployer. The
contracts, the keeper, the agents and the harness were written in Claude Code.
`float/studio/README.md` draws that line and a judge may well read it.

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
