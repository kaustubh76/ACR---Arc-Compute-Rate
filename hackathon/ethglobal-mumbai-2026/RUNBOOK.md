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

## The three roles the chain and the press disagree about

**Measured on the live vault `0xb030e7e5…` on 2026-11-06. Do this before any
hosted World run, or the demo fails at its last step.**

The deploy wired the roles to the addresses in step 2 above. The press was
configured later, from `.env`, with three keys of its own. Nobody reconciled
them, and nothing announced it:

| role | the chain holds | the press signs with |
|---|---|---|
| executor | `0x7FAAC6F8…83A0` (`isExecutor` true) | `0x89400a94…A4b0` (`isExecutor` **false**) |
| `humanApprover` | `0x64E21e01…8d16` (the deployer) | `0x674f6f13…E7AF` |
| `guestRegistrar` | `0x64E21e01…8d16` (the deployer) | `0xde52035E…6C10` |

`treasurerBinding` is still zero and `paused()` is false.

**Two of the three already fail loudly.** `vault_status()` refuses with "our
signer is not an authorized executor", and `guest_preflight()` with "our signer
is not the vault's guest registrar". The approver did not, which is why
`HumanGate.preflight()` now checks it too: left unchecked, the approver is the
one that fails **last** — a payment parked, a human sent to their phone, nine
validation rungs cleared, a signature made, and then `executeApproved` reverting
`bad approval`. On camera that reads as the chain rejecting a verified person.

**Use the script, not the pasted commands below.**

```bash
uv run python scripts/world_golive.py                      # DRY RUN, reads only
uv run python scripts/world_golive.py --send               # the three rotations
uv run python scripts/world_golive.py --send --bind-one-shot   # + the binding
```

It derives the press's addresses from `.env` rather than trusting a copied
string, **reads every role back** after writing it (a `cast send` that mined is
not a role that changed), is **idempotent** so a second run resumes rather than
repeats, and keeps the irreversible step behind a **second explicit flag**. It
refuses outright if the chain already holds a different non-zero binding, since
at that point the vault is stranded and a revert would explain less. It ends by
printing `vault_status()` and `guest_preflight()`, which is the only real
witness: roles and a binding are inputs, those two sentences are the outcome.

The raw calls are kept below as a fallback and as documentation of what the
script does.

**The fix, from the owner key `0x64E21e01…8d16`.** All three setters are
`onlyOwner` and none is one-shot, so this is a rotation rather than a redeploy.
The guards pass in either order, because the press's executor and approver are
different addresses from each other.

```bash
V=0xb030e7e592eb2d8a989c7cbca01270b957bb4bdc
R=https://rpc.testnet.arc.io
# --- point the chain at the keys the press actually holds -----------------
cast send $V "setExecutor(address,bool)" 0x89400a9462f0d7A19a22d183767fe6F2B1ABA4b0 true \
  --rpc-url $R --private-key $OWNER_KEY
cast send $V "setApprover(address)"      0x674f6f1347b0A73014B85f6CCe17a7ECCACAE7AF \
  --rpc-url $R --private-key $OWNER_KEY
cast send $V "setGuestRegistrar(address)" 0xde52035E5857ae08d308A4b33d01e63173eF6C10 \
  --rpc-url $R --private-key $OWNER_KEY

# --- read them BACK. A send that mined is not a role that changed. --------
cast call $V "isExecutor(address)(bool)" 0x89400a9462f0d7A19a22d183767fe6F2B1ABA4b0 --rpc-url $R
cast call $V "humanApprover()(address)"  --rpc-url $R
cast call $V "guestRegistrar()(address)" --rpc-url $R
```

`humanApprover()` is the getter; there is no `approver()` and asking for one
reverts, which looks like a broken vault rather than a wrong method name.

**The alternative, if the deploy-time keys are to hand**, is the reverse: put
`0x7FAA…`, `0x64E2…` and `0x64E2…` into the press's `.env` instead. Cheaper (no
transactions) but it makes the approver the owner key, and the vault refuses an
approver that is also an executor — so the executor must stay distinct.

## The self-custody identity, and why none of it is configuration

Stored 2026-11-06 in gitignored files: `data/world-selfcustody-key.txt` (mode
600) and `data/world-identity-commitments.json`. Recorded here because the
temptation to paste one of them into `.env` is real and the cost is high.

| value | what it is | where it goes |
|---|---|---|
| self-custody private key | **X25519**, verified by deriving the given public key from it | nowhere |
| self-custody public key | the same 32 bytes, inside hand-made PEM markers that would not parse | nowhere |
| orb identity commitment | a BN254 field element, and a **public** value by design | nowhere |
| face identity commitment | likewise, and distinct from the orb one | nowhere |

**X25519 is a key-agreement key. It cannot sign.** Not an OIDC token, not an
IDKit `rp_context`, not an EIP-712 approval, not a transaction. It is the key
that encrypts an identity backup, so the blast radius of exposing it is someone
who also holds that encrypted blob — not funds.

**An identity commitment is the public Merkle leaf, not a credential.** A World
ID proof needs the identity SECRET (the commitment's preimage) plus an inclusion
path from World's sequencer plus the circuit. The commitment is the output of
that secret, so holding it proves nothing and unlocks nothing.

**THE ONE SLOT WHERE USING IT IS WORSE THAN LEAVING IT EMPTY.** Measured, not
predicted: `signRequest` **accepts** those 32 bytes, because almost any 32 bytes
is a valid secp256k1 scalar, and returns a syntactically perfect 132-character
signature. So `ACR_IDKIT_SIGNING_KEY=<that key>` would pass the route's config
check, return `status: "ok"`, render the widget, and open a real sheet on a real
phone — and World would reject it, because the public half is registered to no
`rp_id`. That is precisely the "renders perfectly and fails only at World"
failure `apps/terminal/lib/rpContext.test.ts` exists to prevent, arriving
through a different door. A page that says "not configured" is strictly better
than one that fails in a stranger's hand.

**What it does tell us, and it is worth knowing.** Two distinct commitments means
the account carries **both orb and face** credentials. So when a client finally
exists, the human half can satisfy the stronger `orb-face` class the policy gate
demands — which was an open question, not a given.

What is still needed is unchanged and comes only from the Developer Portal: a
`client_id`/`client_secret` for Agent Pass, and an `rp_id` plus its registered
secp256k1 signing key for IDKit.

## Proving the Agent Pass probe before a credential exists

`make world-probe` is the first command you will run when the sandbox client
lands, and until now **nobody had ever run it successfully** — there was no way
to, so a typo in it would have surfaced at the portal with the clock running.
There is now:

```bash
make world-probe ARGS=--fake              # a local issuer answers; ~10s
make world-probe ARGS="--fake --kind policy"   # the stronger class, orb-face
make world-probe ARGS="--fake --fake-denies"   # the refusal path
```

It runs the **same** `_run()` the real command does — discovery and its issuer
check, the essential-`acr` claims parameter, the device grant, the poll table,
the nine rungs, and the printed `acr`/`amr`/`auth_time`/elapsed. Only who
answers is synthetic. A successful `--fake` run means the only thing left
untested is World's issuer, which is the irreducible part.

The same issuer drives the rehearsal's leg 5D:

```bash
REHEARSE_WORLD=fake make rehearse-float   # 97 checks; the default is 80
```

That one parks a real out-of-policy payment, fetches a token over HTTP, clears
the nine rungs on it and releases the money on chain. **Keep the default mode
for filming**: it is socket-free and a port bind on the critical path is a new
way to fail.

**It is not evidence about World, and the documents say so.** Never let a
`--fake` number reach the debrief's three *pending the live run* rows; those
measure World's own issuance and this does not.

## Checking the IDKit credentials the moment they arrive

There is no separate probe for this and none is needed: the context route
already answers with a named reason for every configuration fault, so asking it
once *is* the check. From `apps/terminal`, with the three values in
`.env.local`:

```bash
npm run build && npm start &
curl -s -XPOST localhost:3000/api/float/idkit/context \
  -H 'content-type: application/json' \
  -d '{"agent":"0x89400a9462f0d7A19a22d183767fe6F2B1ABA4b0"}' | python3 -m json.tool
```

`status: "ok"` with an `rp_context` means the key signs and the press bound the
nonce. Anything else names which of the three values is wrong, and the join page
shows the same sentence. Do this **before** pointing a camera at the page: every
fault here is silent in the browser until the sheet fails on a phone.

What it still cannot tell you is whether World accepts the signature, because
that needs a real proof from World App against an `rp_id` registered to our key.
That hop has no local witness, and the submission says so rather than implying
a green light here covers it.

**`treasurerBinding` stays last.** It is one-shot from zero, it hashes the
issuer string, and a wrong value is worse than none: the approval would still be
valid and would bind to the wrong person. Set it only from what `make
world-enroll` prints, and only once the issuer is final.

## Putting the float routes on the hosted press

**The press currently serves none of them.** Probed 2026-11-06:
`acr-api-1fto.onrender.com/openapi.json` lists **53 routes and no `/float/*`**,
because `render.yaml` pins `acr-api:2026-10-16-0632` and that image predates the
float work by about twenty days. `/float/checkpoints`,
`/float/checkpoint/{id}`, `/float/guest/bind` and `/float/guest/claim` are all on
`origin/main`; none of them is running anywhere.

Everything needed is already in `deploy/redeploy-render.sh`. In order:

```bash
# 0. THE RIGHT KEY. Three Render accounts, and no key sees them all. The one
#    named RENDER_API_KEY owns only acr-probe-free; testnet acr-api lives in
#    the other workspace and a wrong key fails late, as "not found: service"
#    AFTER the image is built and pushed.
export RENDER_API_KEY="$RENDER_API_KEY_PYPI_WORKSPACE"

# 1. The free tier has NO DISK and the seller rehydrates from a file inside
#    the image, so a redeploy can silently erase production's own records.
#    The script's preflights refuse for you; if they say production is ahead:
make archive-decisions   # then COMMIT the archive before going on

# 2. Build, push, pin, redeploy, verify. --platform linux/amd64 is mandatory
#    from this Mac: an arm64 push produces an image Render accepts and then
#    cannot start, and there is no second route to this host.
./deploy/redeploy-render.sh

# 3. THE WITNESS IS THE ROUTE LIST, never the latency. A pinned tag that
#    shipped nothing answers /health perfectly.
curl -s https://acr-api-1fto.onrender.com/openapi.json \
  | python3 -c "import json,sys; p=json.load(sys.stdin)['paths']; f=sorted(x for x in p if 'float' in x); print(len(p),'routes;',f)"
# expect 57 and all four /float paths. 53 and none means the tag did not move.
```

Then the env. `render.yaml` carries the float and World block, with nine values
committed and nine marked `sync: false` for the dashboard. **It is unproven that
blueprint edits auto-sync to this service** — the dashboard has been the truth
for the image line before — so treat `render.yaml` as the authoritative
checklist and confirm each key in the dashboard. And note that **editing an env
var there does not restart the service**: finish with
`SKIP_BUILD=1 ./deploy/redeploy-render.sh`.

**What a redeploy does not buy.** The guest join still stands down without the
IDKit signing key, and the approval card still stands down without the sandbox
client. A redeploy turns a 404 into a page that says what it is waiting for,
which is worth having and is not the same as a working flow.

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
| 2:40 | `npm run verify` — leave the tape running, it is fine | "Fourteen checks, re-derivable from one command, printing what they observed rather than a tick. Including the one that matters: the sleeve was pulled *before* the seller was paid, proven by log order inside a single transaction — Arc's RPC has no tracing, so this proof works for anyone with an ordinary node." |
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
