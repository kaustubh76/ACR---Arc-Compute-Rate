/* The connection ladder — the honesty system's tiers, derived (never stored)
   from signals the data layer already produces. Pure logic, unit-tested in
   connection.test.ts; the client wiring lives in useConnection.ts.

   Tiers, most-alive first:
     live         — the press answered this poll
     stale        — it answered recently; we're retrying ("last updated Xs ago")
     waking       — a cold free-tier press is spinning up (~45s measured)
     onchain-only — FastAPI is down but ACROracle answers a direct read
     archived     — nothing reachable; the bundled edition
     linking      — first paint, no fetch has resolved yet (fetchedAt === 0) */

export type ConnState = "linking" | "live" | "stale" | "waking" | "onchain-only" | "archived";

/** How long a lost connection still counts as "stale (retrying)" rather than
 *  falling through to waking/archived. ~6 poll cycles. */
export const STALE_WINDOW_S = 90;

/** How long the "waking the press" tier is shown after the wake ping fires.
 *  Render free tier measured 43–73s cold across runs; leave headroom. */
export const WAKE_WINDOW_S = 120;

/** The countdown shown alongside the waking tier (a middle-of-road estimate;
 *  the tier itself persists to WAKE_WINDOW_S). */
export const WAKE_ETA_S = 60;

export interface ConnInput {
  /** envelope.live from the terminal feed */
  live: boolean;
  /** envelope.fetchedAt — 0 is the peekTerminal() sentinel: provisional,
   *  no fetch (server or client) has resolved yet */
  fetchedAt: number;
  /** epoch seconds when a live envelope was last observed this tab, or null */
  lastLiveAtS: number | null;
  /** epoch seconds when the wake ping was fired, or null */
  wakeStartedAtS: number | null;
  /** a direct on-chain oracle read is answering */
  onchainOk: boolean;
  /** current epoch seconds (0 during SSR — resolves to linking/live only) */
  nowS: number;
}

export interface ConnStatus {
  state: ConnState;
  /** seconds since the press last answered (stale tier), else null */
  ageS: number | null;
  /** seconds remaining on the waking estimate (waking tier), else null */
  wakeRemainingS: number | null;
}

export function connState(input: ConnInput): ConnStatus {
  const { live, fetchedAt, lastLiveAtS, wakeStartedAtS, onchainOk, nowS } = input;

  if (live) return { state: "live", ageS: null, wakeRemainingS: null };

  // Nothing has resolved yet — say "linking", never a false "archived".
  if (fetchedAt === 0) return { state: "linking", ageS: null, wakeRemainingS: null };

  if (lastLiveAtS != null && nowS > 0) {
    const age = nowS - lastLiveAtS;
    if (age >= 0 && age <= STALE_WINDOW_S) {
      return { state: "stale", ageS: age, wakeRemainingS: null };
    }
  }

  if (wakeStartedAtS != null && nowS > 0) {
    const elapsed = nowS - wakeStartedAtS;
    if (elapsed >= 0 && elapsed <= WAKE_WINDOW_S) {
      return {
        state: "waking",
        ageS: null,
        wakeRemainingS: Math.max(0, WAKE_ETA_S - elapsed),
      };
    }
  }

  if (onchainOk) return { state: "onchain-only", ageS: null, wakeRemainingS: null };

  return { state: "archived", ageS: null, wakeRemainingS: null };
}
