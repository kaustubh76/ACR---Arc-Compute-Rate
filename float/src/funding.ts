/**
 * Can the treasury actually pay for this, and is it worth asking the chain?
 *
 * WHY THIS EXISTS, because it looks like a convenience and is not one.
 *
 * `FloatVault.classify` is the vault's own dry run, and it is the thing every
 * caller is told to use before spending gas. It runs twelve ordered checks —
 * paused, unknown agent, frozen, seller, replay, units, no print, stale,
 * rotated, band, per-request, daily cap — and **not one of them asks whether
 * the money is there.** `_check` never consults the sleeve. So a quote can
 * clear all twelve and still fail at the just-in-time pull.
 *
 * The two failures are not alike and must not be collapsed:
 *
 *   A POLICY refusal is an EVENT. `requestSpend` emits `Denied` and the
 *   transaction SUCCEEDS. That event is the product's whole argument — it is
 *   what the tape shows and what a judge reads — so a policy-refused request is
 *   worth sending even on an empty treasury.
 *
 *   AN UNFUNDED TREASURY IS A REVERT, and it is worse than it sounds.
 *   Measured on anvil with the check disabled: the node rejects the
 *   transaction at estimation, so it never mines and **no gas is charged** —
 *   but viem throws `ContractFunctionExecutionError` and the throw takes the
 *   REST OF THE TICK with it. The waster's deliberate refusal, the agent-wallet
 *   invariant check and the whole report never run. So the cost is not a wasted
 *   fee, it is a dead tick that produces nothing and looks like a crash.
 *
 * So the rule is narrow on purpose: hold back **only** the request that policy
 * would allow and funding would sink. Anything else goes to the chain.
 *
 * This is advisory and the chain stays authoritative. A keeper rebalance
 * landing between the read and the send can make it wrong in either direction.
 * The aim is not to make the revert impossible — it is to stop walking into it
 * predictably, which has happened: `sweep.ts` exists because an overnight tape
 * walked the balance into the seller and then produced "hours of `treasury
 * cannot cover this`, one per tick, which looks precisely like a broken product
 * to anyone reading the dashboard in the morning".
 */

/** Six-decimal USDC, rendered the way every other surface renders it. */
const usd = (n: bigint) => `$${(Number(n) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;

export type Funding =
  | { readonly send: true; readonly held: bigint }
  | { readonly send: false; readonly held: bigint; readonly quote: bigint; readonly short: bigint };

/**
 * @param policyCode the `code` from `classify`: 0 means policy allows it.
 * @param held       `totalValueUsdc()` — the buffer plus every sleeve.
 * @param quote      what this payment would move.
 */
export function fundingCheck(policyCode: number, held: bigint, quote: bigint): Funding {
  // Policy already refuses it: send anyway, so the chain writes the `Denied`.
  if (policyCode !== 0) return { send: true, held };
  if (held >= quote) return { send: true, held };
  return { send: false, held, quote, short: quote - held };
}

/** The sentence a held-back request reports, in the same voice as a refusal. */
export function fundingReason(f: Funding): string {
  if (f.send) return "";
  return (
    `the treasury controls ${usd(f.held)} and this needs ${usd(f.quote)}, ` +
    `${usd(f.short)} short — not sent. \`requestSpend\` reverts rather than ` +
    `emitting a refusal, so the node rejects it at estimation and the throw ` +
    `would kill the rest of this tick. \`npm run sweep\` returns the seller's ` +
    `takings if this is the test loop.`
  );
}
