/* Server-side data loading. Route handlers and server components share this —
   the browser only ever talks to the Next proxy routes (FastAPI has no CORS
   middleware, and this keeps the offline "archived edition" logic in one place). */

import type { Envelope, TerminalData } from "./types";
import fallback from "./fallback.json";

const API = process.env.ACR_API ?? process.env.NEXT_PUBLIC_ACR_API ?? "http://127.0.0.1:8000";

export function apiBase(): string {
  return API;
}

export async function fetchLive<T>(path: string, timeoutMs = 5000): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return (await res.json()) as T;
  } catch {
    /* offline / cold start — caller falls back */
  }
  return null;
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
