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

/* --- the float ladder's dry run ------------------------------------------- */

export type DryRun = {
  agent: string;
  seller: string;
  units: number;
  quoteUsdc: number;
  index?: string;
};

/** The parameters of a `classify` dry run, or a named refusal.
 *
 *  VALIDATION HERE REJECTS WHAT CANNOT BE ENCODED, NOT WHAT WOULD BE REFUSED,
 *  and the distinction is the whole feature. The vault's ladder has a rung for
 *  absurd units and a rung for a quote outside the band, and a reader tripping
 *  those on purpose is the thing this endpoint exists to let them do. A guard
 *  that bounced a 50x quote with its own error would be answering a question the
 *  chain was about to answer better, and would hide the rung.
 *
 *  So the bounds are only the ones arithmetic needs: a number that survives
 *  `Math.round` into an integer, an address that is 20 bytes, an agent name
 *  short enough to hash, and an index that is 32 bytes if given at all.
 */
export function dryRunParams(p: URLSearchParams): { ok: true; req: DryRun } | { ok: false; error: string } {
  const agent = (p.get("agent") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agent)) {
    return { ok: false, error: "agent must be a short name the vault knows" };
  }

  const seller = (p.get("seller") ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(seller)) {
    return { ok: false, error: "seller must be a 20 byte address" };
  }

  const index = (p.get("index") ?? "").trim();
  if (index !== "" && !/^0x[0-9a-fA-F]{64}$/.test(index)) {
    return { ok: false, error: "index must be a 32 byte id" };
  }

  /* `Number.MAX_SAFE_INTEGER / 1e6` for the quote, because it is multiplied by
     1e6 into USDC units before it reaches the chain. Above that the rounding
     itself is wrong, which would send the vault a different number than the one
     on screen — a dry run that classifies something the reader did not ask
     about is worse than a refusal. */
  const units = Number(p.get("units"));
  if (!Number.isFinite(units) || units < 0 || units > 1e15) {
    return { ok: false, error: "units must be a number this endpoint can encode" };
  }

  const quoteUsdc = Number(p.get("quote"));
  if (!Number.isFinite(quoteUsdc) || quoteUsdc < 0 || quoteUsdc > Number.MAX_SAFE_INTEGER / 1e6) {
    return { ok: false, error: "quote must be a usdc amount this endpoint can encode" };
  }

  return {
    ok: true,
    req: { agent, seller, units: Math.round(units), quoteUsdc, ...(index ? { index } : {}) },
  };
}
