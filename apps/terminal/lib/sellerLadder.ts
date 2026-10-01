/* Host failover for the seller — pure logic, no env and no fallback.json.
 *
 * Same split `lib/connection.ts` states in its own header: the decisions live
 * here and are unit-tested in sellerLadder.test.ts, the wiring (reading
 * `ACR_API`, holding the one instance) stays in lib/api.ts.
 *
 * WHY THIS EXISTS AT ALL. `ACR_API` named a Render service that had been
 * SUSPENDED. Every request got 503 "This service has been suspended by its
 * owner", so every route on the live terminal served the committed bundle while
 * the mainnet seller sat there answering in under a second — for two days,
 * silently. This ladder is the cushion. It was shipped untested, which for the
 * one mechanism now keeping the public terminal on mainnet was the wrong order.
 */

/** What one attempt against one host came back as.
 *  `hostFailed` means "this host is not serving", NOT "the answer was a no":
 *  a 402 from the paywall and a 404 for a missing series are both correct
 *  answers, and moving a paid request to a host that did not quote it would be
 *  a bug rather than a cushion. */
export interface Attempt<T> {
  ok: boolean;
  hostFailed: boolean;
  value: T;
}

export interface LadderState {
  /** The host being used right now. */
  active: string;
  /** True once a fallback has stuck, so the next call does not re-pay the failure. */
  fellBack: boolean;
}

export interface Ladder {
  state(): LadderState;
  /** Run `attempt` against the active host, falling through on a host failure. */
  run<T>(attempt: (base: string) => Promise<Attempt<T>>): Promise<T>;
}

/** A ladder over `candidates`, tried in order. One candidate means no fallback
 *  behaviour at all — which is what a deployment with no override, or an
 *  override equal to the published host, should get. */
export function makeLadder(candidates: readonly string[], onFallback?: (from: string, to: string) => void): Ladder {
  let active = candidates[0];
  let fellBack = false;

  return {
    state: () => ({ active, fellBack }),

    async run<T>(attempt: (base: string) => Promise<Attempt<T>>): Promise<T> {
      const first = await attempt(active);
      // An answer, even an unwelcome one, ends it here.
      if (first.ok || !first.hostFailed) return first.value;

      const next = candidates.find((c) => c !== active);
      if (!next) return first.value;

      const second = await attempt(next);
      if (second.ok) {
        onFallback?.(active, next);
        active = next;
        fellBack = true;
        return second.value;
      }
      // Both are down. Return the FIRST answer: the caller asked the configured
      // host, and the configured host's error is the one worth reporting.
      return first.value;
    },
  };
}
