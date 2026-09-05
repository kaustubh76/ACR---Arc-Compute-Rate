/* Server-side data loading. Route handlers and server components share this —
   the browser only ever talks to the Next proxy routes (FastAPI has no CORS
   middleware, and this keeps the offline "archived edition" logic in one place). */

import type { Envelope, TerminalData } from "./types";
import fallback from "./fallback.json";

const API = process.env.ACR_API ?? process.env.NEXT_PUBLIC_ACR_API ?? "http://127.0.0.1:8000";

export function apiBase(): string {
  return API;
}

export type UpstreamStatus = "ok" | "error" | "timeout";

/** Like fetchLive, but reports WHY the upstream failed so proxies can stamp
 *  `upstream` on their envelope — the UI renders "press unreachable"
 *  differently from a genuine empty feed. Failures are logged (once per call)
 *  so a fall-back to the archived edition is diagnosable from server logs. */
export async function fetchLiveMeta<T>(
  path: string,
  timeoutMs = 5000,
): Promise<{ data: T | null; upstream: UpstreamStatus }> {
  try {
    const res = await fetch(`${API}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { data: (await res.json()) as T, upstream: "ok" };
    console.warn(`[terminal] upstream ${res.status} on ${path}`);
    return { data: null, upstream: "error" };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    console.warn(`[terminal] upstream ${timedOut ? "timeout" : "unreachable"} on ${path}`);
    return { data: null, upstream: timedOut ? "timeout" : "error" };
  }
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
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { data: (await res.json()) as T, upstream: "ok" };
    console.warn(`[terminal] upstream ${res.status} on POST ${path}`);
    return { data: null, upstream: "error" };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    console.warn(`[terminal] upstream ${timedOut ? "timeout" : "unreachable"} on POST ${path}`);
    return { data: null, upstream: timedOut ? "timeout" : "error" };
  }
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
