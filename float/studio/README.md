# What Arc Studio did, and what it did not

This directory is evidence, not code. It records the work Arc Studio actually
performed on Float, so the claim can be checked rather than taken.

The honest sentence, which is narrower than "built with Arc Studio" and survives
being questioned:

> Arc Studio compiled the treasury policy from English, audited the vault, and
> deployed the contracts. The rest of Float was written in Claude Code.

## 1 · Compiling the policy from English

This is the product beat, not a demo flourish. A treasurer should not have to
write Solidity, JSON, or a transaction — they should be able to say what the
treasury may do. Arc Studio is the component that turns the sentence into a
configuration; this repository is what refuses it if it is wrong.

**What the treasurer said**, verbatim, and the whole input:

> "Freeze the agent called waster. For everyone else, never pay more than 1%
> above the ACR fair price, keep two days of forecast spend liquid, and keep all
> of the idle float in the working vault."

Studio was given `policy.schema.json` (the contract its output must satisfy) and
`policy.config.json` (the policy currently on chain), and told to change only
what was asked for.

**What it produced** — `policy.generated.json` in this directory, pulled out of
the sandbox with `arc-studio pull`. It changed exactly one field:

```
agents.waster.frozen: false -> true
```

and left `maxPremiumBps` (100), `bufferHours` (48) and `workingShareBps` (10000)
alone, correctly, because they already expressed what the treasurer asked for.
It also left `humanMaxPremiumBps` at 2000 rather than "tidying" it, which matters:
dropping it below `maxPremiumBps` would mean a human approval *narrowing* the
allowed band, and both the schema and the vault refuse that.

**What Studio said about its own output**, which is the reason the next step exists:

> "I didn't run it through a schema validator, but I checked it by eye against
> `policy.schema.json`."

## 2 · Why its output is checked rather than trusted

`float/src/policy.ts` validates every candidate config before a transaction is
built, and an invalid one is refused with the chain left holding the last good
policy. A half-applied policy is worse than an unchanged one, because nobody can
tell which rules are live.

That gate is not aimed at Arc Studio in particular — it would refuse a config
from a human, a script, or a future model just as readily. But a language model
emitting a financial policy is exactly the case it was written for, and "checked
by eye" is exactly the assurance it replaces.

Run it yourself:

```bash
cd float
node --import tsx -e 'import{readFileSync}from"node:fs";import{validate}from"./src/policy.ts";console.log(validate(JSON.parse(readFileSync("studio/policy.generated.json","utf8"))))'
```

Result on this file: **accepted**.

## 3 · The loop, end to end

Measured on a local chain, in this order:

```
apply the policy Arc Studio wrote
  waster.frozen: false -> true          1 transaction
the very next request from each agent
  scout  fair $1.05 quote $1.05525 -> PAID receipt #4
  waster fair $1.05 quote $3.15     -> REFUSED (agent frozen by policy)
```

The refusal *reason* is the thing to watch. Before the policy landed, waster was
refused for `"quote exceeds ACR fair band"` — it was overcharging. After, the
same request is refused for `"agent frozen by policy"`. The policy did not merely
get written; it is what answered.

## 4 · What Arc Studio did not do

Stated plainly, because a vague claim collapses under one question and a narrow
one does not:

- It did not write `FloatVault.sol`, `FloatPrintStore.sol`, the sleeves, or their
  75 tests.
- It did not write the keeper, the agents, the MCP server, the policy validator,
  or the acceptance harness.
- It did not author the dashboard. It **hosts** it — `index.html` was written in
  Claude Code and Studio serves it byte-for-byte, which `arc-studio cat` confirms.
- It did not touch the World ID gate, which belongs to a separate workstream and
  was written outside Studio.

See `hackathon/ethglobal-mumbai-2026/CONTINUITY.md` for the full attribution,
including which parts of this repository were authored with AI assistance, as
ETHGlobal's rules require.
