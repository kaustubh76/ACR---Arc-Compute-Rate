# Eco Sauce on Arc — asking the venue before the money moves

A Sauce program that answers one question against live Arc state, with no
transaction in existence:

> **Can the yield venue actually deliver this shortfall, right now?**

Float's whole claim is that idle float earns yield until the second it is spent,
and that the exact shortfall is pulled out of Morpho in the same transaction as
the payment. That pull is the one step that can fail for reasons outside our
contracts: the venue is someone else's, and it can run dry, close its gates or
stop being the vault we think it is. `jit_preflight.sauce.ts` asks it.

```bash
make float-sauce          # installs the CLI here, then runs both cases
```

## What it checks, and why each line is there

| the check | why it is not decoration |
|---|---|
| `asset() == USDC` | if the venue's asset is not our USDC, every number below is denominated in something else. Our sleeve asserts this once in its constructor; this asserts it against the venue as it is today |
| `convertToAssets(balanceOf(venue, sleeve))` | the position, converted from a **share** balance. Shares are 18 decimals against 6-decimal USDC (`virtualShares` is 1e12), so feeding `convertToAssets` an amount returns approximately zero |
| `maxWithdraw(sleeve) == 0` | Morpho Vault V2 returns zero from **every** `max*` function, by design and stated in its own source. A sleeve that sized a withdrawal from `maxWithdraw` reports an empty position forever. This asserts the trap on chain instead of describing it in a comment |
| `position >= needed` | the question itself |

## It was verified by making it fail

A pre-flight that only ever says yes proves nothing, so both directions are run
against the live venue on Arc Testnet:

```
need $0.50  → The cook succeeds from 0x64E21e01…, gas 121979
need $50    → The cook reverts: the program threw
              "the sleeve cannot cover this shortfall"
```

Both at a real block, nothing signed, nothing sent.

## Two honest limits

**Arc serves no `eth_simulateV1`.** Probed directly: `eth_simulateV1`,
`debug_traceCall`, `eth_createAccessList` and `eth_callMany` all return
`-32601 method not supported`; only `eth_call`, including the state-override
form, works. Sauce handles this and says so in its own output:

> Simulated with `eth_call` on the state of block 70978695 (the endpoint did not
> run `eth_simulateV1`) … `eth_call` returns no logs, so what the cook moved is
> not shown.

So this returns a verdict and a gas figure, and no events. That is a property of
Arc, not of Sauce — it is the same missing-tracing fact that makes `walk.html`
prove the just-in-time order by log index instead of by a call trace.

**It asks the venue, not the policy.** The vault's own `requestSpend` is
`onlyExecutor`, and in Sauce *"every call a program makes comes from the Pot: the
Pot is `msg.sender`"*. Mirroring the spend path would mean authorising a
program-created Pot as an executor — widening who may move treasury money, to
make a demo. We declined. `classify` would be reachable as a view, but the half
worth having is this one: the policy is ours and already tested, while the venue
is the part we do not control.

## Why this is not in `float/package.json`

`@eco-incorp/sauce` is 22 MB with Solana transitive dependencies and a
proprietary licence. CI runs `npm ci` in `float/`, and a judge cloning the repo
should not pay for this to run the acceptance suite. So it lives here with its
own manifest, its `node_modules` is gitignored, and acceptance check **T13**
skips with a printed reason when the CLI is absent.
