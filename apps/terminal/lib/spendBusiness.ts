/* Which business /spend opens on when the link names none.
 *
 * The registry lists every chain's businesses (the press filters nothing), so
 * taking the first row put a mainnet reader on testnet `acr-fleet` (measured
 * 2026-10-16, the day the first mainnet business was onboarded). The reader's
 * chain picks; the first row is only the fallback when that chain has none. */
import type { ChainKey } from "./chainChoice";

export function defaultBusiness(rows: ReadonlyArray<{ slug: string; chain: string }>, chain: ChainKey): string | null {
  return (rows.find((b) => b.chain === chain) ?? rows[0])?.slug ?? null;
}
