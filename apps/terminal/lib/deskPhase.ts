/** Which step of the Public Desk a returning reader is on.
 *
 *  Extracted from the component so it can be tested honestly: this decision is
 *  what a reader sees after every wallet poll and every page reload, and it got
 *  it wrong for the most ordinary case there is.
 */
export type DeskPhase = "closed" | "opening" | "pin" | "unfunded" | "collateral" | "trading";

export interface WalletState {
  /** Spendable USDC in the reader's own wallet (null when the read failed). */
  usdc: number | null;
  /** Whether this wallet is known to have collateral posted on the venue. */
  collateralized: boolean;
}

/** The phase a provisioned wallet belongs in.
 *
 *  **Collateral first, balance second.** Posting the stake MOVES it to the
 *  venue, so a wallet holding 0.00 is the NORMAL end state of the happy path —
 *  not an unfunded one. Deciding on spendable balance first sent exactly those
 *  readers back to "unfunded", telling them to claim a stake they had just
 *  spent, and the trade buttons never rendered. It survived earlier runs only
 *  because the trade happened in the same page session as the deposit; any
 *  poll or reload afterwards demoted them.
 */
export function deskPhase({ usdc, collateralized }: WalletState): DeskPhase {
  if (collateralized) return "trading";
  return usdc !== null && usdc > 0 ? "collateral" : "unfunded";
}
