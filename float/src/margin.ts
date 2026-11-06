/**
 * How much margin should the treasury's buffer carry, and whose confidence
 * counts toward it?
 *
 * WHY THIS EXISTS. The keeper sizes the buffer as
 *
 *     wanted = spendPerHour * policy.bufferHours * (10_000 + ciBps) / 10_000
 *
 * where `ciBps` is the provider disagreement averaged over the printed indices.
 * The margin is the part that says "hold a little more than the forecast,
 * because the forecast's own inputs disagree with each other".
 *
 * AND IT WAS AVERAGING PRINTS OF ANY AGE. `rebalance()` read the whole on-chain
 * policy tuple and used exactly one field of it — `bufferHours` — while
 * `maxPrintAge`, the vault's own definition of a print too old to trust, sat in
 * the same tuple and was discarded. It then read `latest(index)` for every index
 * and destructured only `ci`, dropping `postedAt` on the floor. So a model whose
 * price fetch had failed hours ago still contributed its last known confidence
 * to the buffer the treasury holds today.
 *
 * Nothing was at risk — the margin only makes the buffer bigger or smaller, and
 * `rebalance` refuses any move under `minTicketUsdc` anyway. What was wrong is
 * narrower and worth fixing on its own terms: the keeper presented a number as
 * measured from current prints when it was not, and the one field that would
 * have told it otherwise was already in hand.
 *
 * THE RULE, and why it is not stricter. A stale print's confidence is not
 * evidence, so it is EXCLUDED from the average. It does not veto the tick: one
 * stale index among several would then stop the buffer tracking spend at all,
 * and a buffer that has stopped tracking spend is worse than a margin computed
 * from the indices that are fresh. Only an ALL-stale set leaves nothing to
 * measure, and that case reports itself rather than quietly returning zero —
 * the same shape as the keeper's existing "no receipts yet, so no measured rate"
 * early return.
 *
 * The chain stays authoritative either way. This changes what the keeper ASKS
 * for; `FloatVault.rebalance` applies its own bands and minimum ticket, and
 * notably does NOT itself care about print age — see
 * `test_a_stale_print_does_not_stop_a_rebalance` for that asymmetry, pinned on
 * the contract side.
 */

/** One index's latest print, as `FloatPrintStore.latest` returns it. */
export type PrintAge = {
  /** Provider disagreement in basis points. */
  readonly ciBps: number;
  /** Chain time the print was posted. */
  readonly postedAt: bigint;
};

export type Margin =
  /** At least one print was fresh enough to count. */
  | { readonly measured: true; readonly bps: bigint; readonly used: number; readonly skipped: number }
  /** Nothing fresh to measure: no margin, and the caller should say so. */
  | { readonly measured: false; readonly used: 0; readonly skipped: number };

/**
 * @param prints      every printed index's latest print.
 * @param nowS        chain time, in seconds.
 * @param maxPrintAge `policy.maxPrintAge` — the vault's own staleness bound,
 *                    read from the chain rather than hardcoded here. There are
 *                    already nine copies of `1800` in this repository and this
 *                    file is deliberately not the tenth.
 */
export function marginBps(prints: readonly PrintAge[], nowS: bigint, maxPrintAge: bigint): Margin {
  let sum = 0n;
  let used = 0;
  let skipped = 0;

  for (const p of prints) {
    // A print from the future is not fresh, it is a clock problem, and
    // `FloatVault.classify` treats it as stale for the same reason: it guards
    // `postedAt > block.timestamp` before comparing the difference. Matching
    // that here keeps one definition of "too old to trust" in the system.
    const fromFuture = p.postedAt > nowS;
    const tooOld = !fromFuture && nowS - p.postedAt > maxPrintAge;
    if (fromFuture || tooOld) {
      skipped += 1;
      continue;
    }
    sum += BigInt(p.ciBps);
    used += 1;
  }

  if (used === 0) return { measured: false, used: 0, skipped };
  return { measured: true, bps: sum / BigInt(used), used, skipped };
}

/** What the tick log should say about the margin it used. */
export function marginReason(m: Margin, maxPrintAge: bigint): string {
  const bound = `${maxPrintAge}s`;
  if (!m.measured) {
    return (
      `no margin: all ${m.skipped} printed index(es) are older than the policy's ` +
      `maxPrintAge of ${bound}, so there is no current disagreement to measure. ` +
      `The buffer target falls back to the bare forecast.`
    );
  }
  const note =
    m.skipped > 0
      ? ` — ${m.skipped} index(es) skipped as older than ${bound}, so their stale confidence is not in this number`
      : ` — all ${m.used} inside ${bound}`;
  return `margin ${m.bps}bp from ${m.used} index(es)${note}`;
}
