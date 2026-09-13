/* A small in-process throttle for the routes that spend a shared budget.
 *
 * /api/screen holds ONE card for every visitor, so one flood would exhaust the
 * per-key budget at the gate for everyone — and every screened request is a
 * Google call. Two windows, both sliding: per caller and for the whole process.
 * In-process only: a demo page on one Vercel region does not need a shared
 * store, and the API's own per-key budget is the hard backstop behind this.
 */

export interface ThrottleOptions {
  perKey: number;
  global: number;
  windowMs: number;
}

export const SCREEN_THROTTLE: ThrottleOptions = { perKey: 6, global: 60, windowMs: 60_000 };

export class Throttle {
  private hits = new Map<string, number[]>();
  private all: number[] = [];

  constructor(private readonly opts: ThrottleOptions) {}

  /** True when the call may proceed; records it. Pure in time: pass `nowMs`. */
  allow(key: string, nowMs = Date.now()): { ok: true } | { ok: false; reason: "caller" | "everyone"; retryInS: number } {
    const since = nowMs - this.opts.windowMs;
    this.all = this.all.filter((t) => t > since);
    const mine = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (mine.length >= this.opts.perKey) {
      return { ok: false, reason: "caller", retryInS: Math.ceil((mine[0] + this.opts.windowMs - nowMs) / 1000) };
    }
    if (this.all.length >= this.opts.global) {
      return { ok: false, reason: "everyone", retryInS: Math.ceil((this.all[0] + this.opts.windowMs - nowMs) / 1000) };
    }
    mine.push(nowMs);
    this.hits.set(key, mine);
    this.all.push(nowMs);
    // Forget callers that have gone quiet, so the map cannot grow without bound.
    if (this.hits.size > 2000) {
      for (const [k, v] of this.hits) if (!v.some((t) => t > since)) this.hits.delete(k);
    }
    return { ok: true };
  }
}

/** The caller's address behind Vercel: the RIGHT-most forwarded hop is the one
 *  the platform appended and the only one a client cannot forge. */
export function callerKey(headers: { get(name: string): string | null }): string {
  const xff = headers.get("x-forwarded-for") ?? "";
  const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : headers.get("x-real-ip") ?? "local";
}
