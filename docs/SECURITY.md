# Security — the trust model, stated

What you are trusting when you use ACR, who holds which power, and what happens when
something fails. Written for a user with money on the venue, not for an auditor;
the audit itself is [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md). To report a
vulnerability, see the root [`SECURITY.md`](../SECURITY.md).

## What you are trusting

**The number.** Every ACR print is signed by a key in the oracle's signer set and posted
on chain. The estimator that produces it is open source and re-derivable from the public
tape (`make recompute`), but the *posting* is a trusted act: a signer can post a number the
estimator did not produce. Two things bound that trust on `ACROracleV2`:

- **A print may move at most `MAX_MOVE_BPS` from the previous one** (2 000 bp — 20% — at
  deploy). A compromised signer can walk the price, one step per print, each an event on a
  public chain; it cannot jump it. Ten maximal steps reach about 3×, not 100×.
- **The venue settles at the first print the chain saw after expiry**, not at whichever
  print exists when someone calls `settle`. The price is fixed by expiry, and by block time
  the chain assigned — nothing a signer or a caller chooses.

**The signer set.** Exactly the addresses `isSigner()` returns `true` for. At mainnet it is
the press custody wallet alone; the deploy key is retired at deploy (`docs/MAINNET_RUNBOOK.md`
§3 step 5) and `make verify-mainnet` fails if it is not.

**The owner.** Each contract has one owner, with the powers in the table below, transferred
only by a two-step `transferOwnership` / `acceptOwnership`. There is **no timelock**: an
owner action takes effect in the block it lands. Until a multisig exists on Arc mainnet the
owner is the Circle custody owner wallet; this document changes when that does.

## Owner powers, by contract

| contract | owner may | and may not |
|---|---|---|
| `ACROracle`, `ACROracleV2` | add or remove signers; pause posting | post a print without a signer key; edit a posted print; move a print past the bound |
| `ACRFutures` | open a series and name its maker; pause `postCollateral` and `trade` | touch collateral; pause `withdrawCollateral`, `settle` or `settleStale`; change the oracle (immutable) |
| `HumanIdMirror` | add or remove resolvers; **`ownerRebind`** — move a wallet to a different cluster within a window, or clear it, into a cluster that already exists | mint a cluster with no provenance; change the salt commitment (immutable) |
| `ReceiptMirror` | add or remove keepers; `openSettlementLate` — record a settlement past the normal lag | alter a recorded settlement |
| `FeedAccessAttestor` | add or remove signers | — |
| `AttestationRegistry` | *(no owner)* — every seller attests for itself | — |

Every power above emits an event. Nothing is upgradeable; there is no `delegatecall` and no
`selfdestruct`.

## What happens when something fails

**The press stops.** Prints go stale; `/health`, `/ops` and `verify_live` alarm. Trading
continues against the last mark. For an expired series: `settle` needs the first post-expiry
print to have landed within `MAX_SETTLE_AGE` (2 h) of expiry. If the feed was down then,
**`settleStale`** becomes callable by anyone once `SETTLE_GRACE` (7 days) has passed since
expiry, and clears the series at the best print that exists — the first post-expiry print if
the feed resumed late, else the last print before expiry. **Collateral is never locked past
the grace.** The press has died twice on testnet; this is why the hatch exists.

**A big move.** Margin is checked only when you trade (initial margin, `MARGIN_BPS`); there is
no maintenance margin and no liquidation. At settlement every position realizes against the
frozen mark; a trader whose loss exceeds their collateral is floored at zero and the shortfall
is taken from winners **pro-rata**. This is socialized-loss clearing: the pot is conserved
and the contract never pays out more than it holds, and **a winner can be paid less than their
full gain.** Size positions knowing that.

**A signer key is stolen.** On V2 the attacker can move the price 20% per print; the keeper
sees every print and the owner can pause the oracle and remove the signer. Series that settle
during the walk settle at a moved price — the bound limits the damage, it does not remove it.

**An owner key is stolen.** The attacker has the table above: they can pause trading and
posting, add a signer (bounded by `MAX_MOVE_BPS` like any other), rebind human clusters,
and open series. They cannot take collateral or alter the oracle history. The response is
`transferOwnership` from the compromised key to a clean one, which is why it is two-step.

## The gates

- **Paying for prints** — Circle Gateway x402. Replay protection is the EIP-3009 nonce
  in the USDC contract, not anything of ours.
- **The agent card** — EIP-712, signed by the agent's own key. The domain deliberately names
  no `verifyingContract`: there is no registry and no allowlist. That makes the *carded* tier
  free to obtain, so a per-card limit is a per-key limit. Only the **human** tier is scarce.
- **`scopeHash`** is in the card and in the signature, and the gate checks it against
  nothing yet. It is signed for forward compatibility; do not rely on it for authorization.
- **The human tier** — a CAIP-122 signature plus an on-chain `HumanIdMirror.clusterOf` check.
  A claim the chain cannot confirm is a 401, not a downgrade to carded.
- **On mainnet the service refuses to start** unless every gate is explicit and configured
  (`acr_core.mainnet_guard`); the faucet, the demo buyer and the attack lab do not exist
  there, and no environment variable can bring them back.

## Deployed versus source

The venue and oracles on Arc **testnet** were deployed before the move bound, the first-print
rule and the escape hatch existed; their code is immutable and still behaves the old way. A
mainnet deploy from this source has all three. Which generation a venue is can be read from
the chain: `SETTLE_GRACE()` answers on the current one and reverts on the old.

## What this is not

One engineer plus the test suite reviewed the contracts that hold and price money. An
external audit of `ACRFutures` and `ACROracleV2` is recommended before there is more money
on the venue than its operator could make whole.
