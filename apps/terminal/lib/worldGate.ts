/* Is the World ID gate armed on chain, and if not, what is outstanding.
 *
 * WHY THIS IS A PURE FUNCTION IN ITS OWN FILE. The same verdict is needed by
 * the route that reads the chain and by the page that renders it, and a
 * decision duplicated in two places is a decision that will disagree with
 * itself. It also means the truth table can be tested without a chain.
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
};

export type GateVerdict = {
  armed: boolean;
  /** One sentence per thing still to do, in the order it should be done. */
  outstanding: string[];
  /** True once the chain pins a particular person. */
  bound: boolean;
};

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

  return { armed: outstanding.length === 0, outstanding, bound };
}
