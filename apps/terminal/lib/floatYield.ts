/* What the idle float earned, as arithmetic a test can pin.
 *
 * THE BASIS COMES FROM THE SLEEVE'S OWN EVENTS. `Erc4626Sleeve` emits
 * `Parked(usdcAmount)` on the way in and `Pulled(usdcRequested, usdcDelivered)`
 * on the way out, and both movers are `onlyTreasury` with nothing else able to
 * move shares. So the net USDC that crossed the boundary is recoverable
 * exactly, and the gain is the live mark minus that.
 *
 * DELIVERED, NEVER REQUESTED. `withdrawExact` measures the treasury's balance
 * before and after and emits the difference as the second field. A venue can
 * hand back less than it was asked for; counting the request would count money
 * that never arrived, which is the whole reason the contract emits both.
 *
 * THIS UNDERSTATES THE GAIN, AND THAT IS THE RIGHT DIRECTION. `Parked` records
 * the deposit, not the shares minted, and a 4626 vault rounds shares down; a
 * withdraw rounds shares up against the withdrawer. Both biases inflate the
 * evented basis, so the number here is a floor on what was earned. For a meter
 * that must not overclaim, a floor is the correct error.
 *
 * `float/studio/README.md` records this repo already correcting one overclaim
 * in this exact area — "each park loses a rounding unit to the venue's floor,
 * and a venue can lose value on its own" — which is why none of the above is
 * smoothed over.
 */

/** Net USDC across the sleeve boundary, in 6-decimal units. */
export function principalFrom(parked: readonly bigint[], pulledDelivered: readonly bigint[]): bigint {
  const inAll = parked.reduce((a, b) => a + b, 0n);
  const outAll = pulledDelivered.reduce((a, b) => a + b, 0n);
  return inAll - outAll;
}

/** The gain, signed, or null when the basis cannot be trusted.
 *
 *  A basis paged from a window that did not reach the sleeve's first event is
 *  missing deposits, and missing deposits make the gain look larger by exactly
 *  what was missed. There is no safe way to show that number, so it is not
 *  shown. */
export function accruedFrom(valueUnits: bigint, principalUnits: bigint, complete: boolean): bigint | null {
  if (!complete) return null;
  return valueUnits - principalUnits;
}

/** 6-decimal units as decimal USDC. Signed, because the gain can be. */
export function usdc(units: bigint): number {
  return Number(units) / 1e6;
}

/** Did the walk reach the sleeve's own beginning?
 *
 *  True when it walked down to or past the block the sleeve was created in.
 *  A page budget that ran out is NOT completeness, however many events it saw:
 *  the whole risk is deposits older than the window. */
export function reachedStart(fromBlock: number, sleeveBlock: number | null): boolean {
  if (sleeveBlock === null || !Number.isFinite(sleeveBlock)) return false;
  return fromBlock <= sleeveBlock;
}
