/* Server-side data loading. Route handlers and server components share this —
   the browser only ever talks to the Next proxy routes (FastAPI has no CORS
   middleware, and this keeps the offline "archived edition" logic in one place). */

import { isHostFailure, publishedSeller, sellerCandidates } from "./apiBase";
import { makeLadder } from "./sellerLadder";
import type { Envelope, TerminalData } from "./types";
import fallback from "./fallback.json";

const CONFIGURED = (process.env.ACR_API?.trim() || "").replace(/\/$/, "");
const PUBLISHED = publishedSeller().replace(/\/$/, "");

/* ONE MORE RUNG ON THE LADDER, and the reason it exists.
 *
 * `ACR_API` is an operator override, and for two days it named a Render service
 * that had been SUSPENDED — every request got 503 "This service has been
 * suspended by its owner", so every route on the live terminal silently served
 * the archived bundle while the mainnet seller sat there answering fine. The
 * product whose whole job is showing live data showed a fortnight-old snapshot,
 * and nothing anywhere said why.
 *
 * So: a WORKING override still wins outright — a preview, a fork or a testnet
 * deployment is untouched, and nothing here overrides a host that answers. But
 * when the configured seller is unreachable, times out, or returns 5xx, we try
 * this build's published seller before falling all the way back to the archive.
 * A 4xx is NOT a failure of the host — a 402 from the paywall and a 404 from a
 * missing series are both correct answers — so those never trigger it.
 *
 * The rung is only defensible because it is OBSERVABLE: `baseState()` reports
 * which host is being used and whether we fell back, and /api/health and
 * /api/probe surface it. Silence is what made the original fault survive. */
const CANDIDATES: string[] = sellerCandidates(CONFIGURED, PUBLISHED);

/* The decisions live in lib/sellerLadder.ts, unit-tested there; this module
   keeps only the wiring — which hosts, and the one instance they share. Same
   split lib/connection.ts documents for the UI's tier ladder. */
const ladder = makeLadder(CANDIDATES, (from, to) =>
  console.warn(
    `[terminal] seller ${from} is not serving; falling back to ${to}. ` +
      "ACR_API points somewhere dead — fix the variable; this rung is a cushion, not a cure.",
  ),
);

export function apiBase(): string {
  return ladder.state().active;
}

/** Which seller is actually serving, and whether that is the configured one.
 *  Read by /api/health and /api/probe so a stale `ACR_API` announces itself
 *  instead of quietly demoting the whole terminal to the archive. */
export function baseState(): {
  active: string;
  configured: string | null;
  published: string;
  fellBack: boolean;
} {
  const { active, fellBack } = ladder.state();
  return { active, configured: CONFIGURED || null, published: PUBLISHED, fellBack };
}

export type UpstreamStatus = "ok" | "error" | "timeout";

/** A raw fetch that climbs the same ladder, for callers that need the Response
 *  itself rather than parsed JSON — /api/probe reports a status and a body, so
 *  it cannot go through fetchLiveMeta. Without this it would call the configured
 *  host directly and report 503 while every data route on the same page worked,
 *  which is a worse kind of confusing than the bug it is diagnosing. Returns the
 *  base that actually answered, so the caller can say so. */
export async function sellerFetch(
  path: string,
  init: RequestInit,
): Promise<{ res: Response; base: string }> {
  /* A Response or the reason there isn't one. The ladder decides between hosts;
     an unreachable host has no Response, so the error travels with the attempt
     and is re-thrown below if every candidate failed — a fabricated Response
     would be worse than the exception the caller already handles. */
  type RawTry = { res: Response | null; base: string; error?: unknown };

  const out = await ladder.run<RawTry>(async (base) => {
    try {
      const res = await fetch(`${base}${path}`, init);
      const bad = isHostFailure(res.status);
      return { ok: !bad, hostFailed: bad, value: { res, base } };
    } catch (error) {
      return { ok: false, hostFailed: true, value: { res: null, base, error } };
    }
  });

  if (!out.res) throw out.error ?? new Error(`seller ${out.base} is unreachable`);
  return { res: out.res, base: out.base };
}

/** Like fetchLive, but reports WHY the upstream failed so proxies can stamp
 *  `upstream` on their envelope — the UI renders "press unreachable"
 *  differently from a genuine empty feed. Failures are logged (once per call)
 *  so a fall-back to the archived edition is diagnosable from server logs. */
export async function fetchLiveMeta<T>(
  path: string,
  timeoutMs = 5000,
): Promise<{ data: T | null; upstream: UpstreamStatus }> {
  return ladder.run<{ data: T | null; upstream: UpstreamStatus }>(async (base) => {
    try {
      const res = await fetch(`${base}${path}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        return { ok: true, hostFailed: false, value: { data: (await res.json()) as T, upstream: "ok" as UpstreamStatus } };
      }
      console.warn(`[terminal] upstream ${res.status} on ${path}`);
      return {
        ok: false,
        hostFailed: isHostFailure(res.status),
        value: { data: null, upstream: "error" as UpstreamStatus },
      };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      console.warn(`[terminal] upstream ${timedOut ? "timeout" : "unreachable"} on ${path}`);
      return {
        ok: false,
        hostFailed: true,
        value: { data: null, upstream: (timedOut ? "timeout" : "error") as UpstreamStatus },
      };
    }
  });
}

export async function fetchLive<T>(path: string, timeoutMs = 5000): Promise<T | null> {
  return (await fetchLiveMeta<T>(path, timeoutMs)).data;
}

/** The same contract for a POST body — the tape's read proxy is a POST, because
 *  the query text lives server-side and the caller names an allowlisted
 *  operation rather than sending GraphQL. Same timeout, same one-line log, same
 *  `upstream` stamp, so a subgraph outage is diagnosable exactly like a press
 *  outage instead of arriving as an unexplained empty page. */
export async function postLiveMeta<T>(
  path: string,
  body: unknown,
  timeoutMs = 8000,
): Promise<{ data: T | null; upstream: UpstreamStatus }> {
  return ladder.run<{ data: T | null; upstream: UpstreamStatus }>(async (base) => {
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        return { ok: true, hostFailed: false, value: { data: (await res.json()) as T, upstream: "ok" as UpstreamStatus } };
      }
      console.warn(`[terminal] upstream ${res.status} on POST ${path}`);
      return {
        ok: false,
        hostFailed: isHostFailure(res.status),
        value: { data: null, upstream: "error" as UpstreamStatus },
      };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      console.warn(`[terminal] upstream ${timedOut ? "timeout" : "unreachable"} on POST ${path}`);
      return {
        ok: false,
        hostFailed: true,
        value: { data: null, upstream: (timedOut ? "timeout" : "error") as UpstreamStatus },
      };
    }
  });
}

/** Bundled snapshot sections (marketplace / revenue / x402 / exchange sample)
 *  so the crypto-dense proxies never fall back to null. Optional keys — an
 *  older fallback.json just yields undefined and the proxy keeps its legacy
 *  offline shape. */
export function bundleSection<K extends keyof TerminalData>(key: K): TerminalData[K] | undefined {
  return (fallback as unknown as TerminalData)[key];
}

/* Module-scope memo: layout + page + N polling clients cost FastAPI at most
   one upstream request per 5s. */
let memo: { at: number; env: Envelope<TerminalData> } | null = null;
const MEMO_MS = 5_000;

/** Synchronous peek for the layout shell: the last-known envelope if any fetch
 *  has resolved this instance, else the bundled snapshot with `fetchedAt: 0` —
 *  the sentinel the client connection ladder reads as "provisional, no live
 *  fetch has been attempted yet" (rendered as *linking*, never as a false
 *  *archived*). Never blocks; the shell paints instantly regardless of the
 *  backend. */
export function peekTerminal(): Envelope<TerminalData> {
  if (memo) return memo.env;
  return { live: false, data: fallback as unknown as TerminalData, fetchedAt: 0 };
}

export async function loadTerminal(): Promise<Envelope<TerminalData>> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.env;
  // /terminal/data does 3 on-chain reads + a derived payload; a warm box answers
  // in ~3-5s, so allow generous headroom before falling back to the bundle.
  const data = await fetchLive<TerminalData>("/terminal/data", 9000);
  const env: Envelope<TerminalData> = data
    ? { live: true, data, fetchedAt: Date.now() }
    : { live: false, data: fallback as unknown as TerminalData, fetchedAt: Date.now() };
  memo = { at: Date.now(), env };
  return env;
}
