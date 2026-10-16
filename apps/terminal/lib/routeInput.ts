/* Caller input that a route puts into an upstream URL or a shared cache key,
 * checked before it gets there.
 *
 * Measured on production 2026-10-16. `/api/tape?payer=../health%23` made the
 * terminal fetch the press's `/health` and serve it as the payer's TCA card,
 * echoing `../health#` back. The tape page validates its own field, so only a
 * direct caller could do it. But a direct caller is exactly who sends `../`,
 * and a path that answers 5xx also moves the shared host ladder for every
 * visitor on the instance. `/api/onchain?history=constructor` passed the
 * `prints[historyFor]` check through the prototype chain, and any distinct
 * value forced a paced, uncached RPC crawl of the oracle.
 */
import { ADDRESS } from "./parQuery";
import { isIndexId, type IndexId } from "./indices";

/** `?payer=` as a lower-cased address, `null` when absent, or the sentence
 *  saying why it was refused. The tape route answers 422 with that sentence. */
export function payerParam(raw: string | null): { ok: true; payer: string | null } | { ok: false; error: string } {
  if (raw === null || raw === "") return { ok: true, payer: null };
  const v = raw.trim();
  return ADDRESS.test(v)
    ? { ok: true, payer: v.toLowerCase() }
    : { ok: false, error: "payer must be a 0x wallet address (40 hex characters)" };
}

/** `?history=` as one of the indices, else `null` (the route then reads no
 *  history). Ignored rather than refused: the latest prints are still the answer
 *  a caller asked for, and the history is an optional extra. */
export function historyParam(raw: string | null): IndexId | null {
  return raw !== null && isIndexId(raw) ? raw : null;
}

/** `?price=` for a funding plan: a finite, non-negative number, else 0. The old
 *  `Math.max(0, Number(x) || 0)` let `Infinity` through, because it is truthy. */
export function priceParam(raw: string | null): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
