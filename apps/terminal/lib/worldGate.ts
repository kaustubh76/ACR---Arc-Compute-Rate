/* Is the World ID gate armed on chain, and if not, what is outstanding.
 *
 * WHY THIS IS A PURE FUNCTION IN ITS OWN FILE. The same verdict is needed by
 * the route that reads the chain and by the page that renders it, and a
 * decision duplicated in two places is a decision that will disagree with
 * itself. It also means the truth table can be tested without a chain.
 *
 * WHY `governs` AND `ungoverned` ARE NOT IN `outstanding`. `outstanding` is
 * rendered under a standfirst promising that each entry is a single transaction
 * from the address that deployed the vault, and `armed` is literally
 * `outstanding.length === 0`. The yield path's facts are neither: `rebalance`
 * takes the keeper key and nothing else, `openCheckpoint` accepts only
 * KIND_SPEND and KIND_POLICY so a sleeve move cannot be parked for a human even
 * in principle, and the share cap lives off chain in the keeper's own
 * arithmetic. No owner transaction changes any of that, so putting it in
 * `outstanding` would make the standfirst a lie and would hold `armed` false
 * for ever, destroying the one thing this file is for. They get their own
 * fields, and `armed` keeps its exact meaning and formula.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never says the gate "works" or that a
 * payment has been released. Armed means only that the chain is in a state
 * where an approval COULD clear: a person is pinned and the roles have been
 * rotated off the address that deployed the vault. Whether a human has ever
 * actually approved anything is a different question, and one the chain answers
 * through checkpoints, not through these four slots.
 *
 * WHY IT COMPARES AGAINST `owner` RATHER THAN AGAINST EXPECTED ADDRESSES. The
 * terminal cannot know which keys the press holds -- they are derived from
 * private keys that live only on the press host, and publishing the expected
 * addresses here would be configuration that can rot. What it CAN see is that
 * `wire()` points every role at the deployer, so a role still equal to `owner`
 * has provably never been rotated. That is a fact about the chain rather than
 * an assumption about a deployment.
 */

export const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

export type WorldGateState = {
  /** The vault these slots were read from, and the chain it sits on. */
  vault: string;
  chainId: number;
  /** `keccak256("acr.treasurer::" + iss + 0x1f + sub)`, or 32 zero bytes. */
  treasurerBinding: string;
  humanApprover: string;
  guestRegistrar: string;
  owner: string;
  paused: boolean;
  /** The one key `rebalance` accepts. Moves float with no checkpoint at all. */
  keeper: string;
  /** The sleeves the buffer is parked into. `ZERO_ADDRESS` when unwired. */
  working: string;
  reserve: string;
};

export type GateVerdict = {
  armed: boolean;
  /** One sentence per thing still to do, in the order it should be done. */
  outstanding: string[];
  /** True once the chain pins a particular person. */
  bound: boolean;
  /** Paths the contract routes through a checkpoint, and what enforces each.
   *  Phrased as a property of the CONTRACT, not of the person, so it stays
   *  true on a vault that pins nobody yet. */
  governs: string[];
  /** Paths that move on one key. Facts about the deployed bytecode and the
   *  off-chain keeper, not tasks: no owner transaction changes these. */
  ungoverned: string[];
};

/* THE UNCONDITIONAL HALF OF THE BOUNDARY, EXPORTED SO A PAGE CAN RENDER IT
 * WITHOUT READING THE CHAIN.
 *
 * Found by building this and serving it: the lists were behind `verdict`, which
 * is null whenever the chain read fails, so on a cold start or a throttled read
 * the page showed four approval slots and NO boundary -- exactly the misleading
 * state the boundary exists to prevent. These sentences describe the deployed
 * bytecode, not this deployment, so nothing about them needs a successful read.
 * `gateVerdict` still returns them, and appends the two entries that genuinely
 * do depend on state. */
export const GOVERNS = [
  "payments: executeApproved needs a signature from the approver over this checkpoint's own hash",
  "policy: setPolicy, setAgent and allowSeller route through a checkpoint while requirePolicyCheckpoint is on",
];

export const UNGOVERNED = [
  "rebalance moves float between the buffer and the sleeves on the keeper key alone: no signature, no cap, no cooldown",
  "openCheckpoint takes only the spend and policy kinds, so a sleeve move cannot be parked for a human even in principle",
  "setSleeves re-points a sleeve on the owner key alone (audit finding M5, accepted rather than repaired)",
  "the share cap and the minimum interval live in the keeper's own arithmetic off chain, so a direct rebalance bypasses both",
];

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function gateVerdict(s: WorldGateState): GateVerdict {
  const outstanding: string[] = [];
  const bound = !same(s.treasurerBinding, ZERO_BYTES32);

  //: Roles first, because they are rotations and can be redone; the binding is
  //: one-shot and belongs last, after the issuer is final. The go-live script
  //: orders its transactions the same way for the same reason.
  if (same(s.humanApprover, s.owner)) {
    outstanding.push("setApprover: the approver is still the address that deployed the vault");
  }
  if (same(s.guestRegistrar, s.owner)) {
    outstanding.push("setGuestRegistrar: the registrar is still the deployer");
  }
  //: THE ONE YIELD FACT THAT IS A TASK. A keeper equal to a gated role is
  //: fixed by a single setKeeper, and it matters for approvals: the key that
  //: releases a parked payment could also move float at will. Every other
  //: yield fact is bytecode and belongs in `ungoverned`.
  if (same(s.keeper, s.humanApprover)) {
    outstanding.push(
      "setKeeper: the keeper is also the approver, so the key that releases a payment can also move float",
    );
  } else if (same(s.keeper, s.guestRegistrar)) {
    outstanding.push("setKeeper: the keeper is also the guest registrar");
  }
  if (!bound) {
    outstanding.push(
      "setTreasurerBinding: the chain pins no particular person yet, so identity rests on the server-side ladder",
    );
  }
  if (s.paused) {
    //: Unshift rather than push: nothing else matters while it is paused, so it
    //: should be the first thing a reader sees.
    outstanding.unshift("the treasury is paused, so no spend can be released at all");
  }

  const governs = [...GOVERNS];
  const ungoverned = [...UNGOVERNED];
  if (same(s.reserve, ZERO_ADDRESS)) {
    //: Not cosmetic. FloatVault guards `reserve != 0` before depositing, so the
    //: reserve share of every rebalance is computed and then silently stays in
    //: the buffer, and the drain ladder has one rung instead of two.
    ungoverned.push(
      "no reserve sleeve is wired, so the reserve share of each rebalance is computed and then stays in the buffer",
    );
  }
  if (same(s.keeper, s.owner)) {
    //: A disclosure, not a task: the owner can already withdraw outright, so a
    //: keeper equal to the owner grants no power it did not have.
    ungoverned.push("the keeper is the address that deployed the vault, which can already withdraw");
  }

  return { armed: outstanding.length === 0, outstanding, bound, governs, ungoverned };
}
