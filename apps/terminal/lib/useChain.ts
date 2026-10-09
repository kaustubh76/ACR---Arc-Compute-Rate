"use client";

/* Which chain this reader is on, client-side.
 *
 * Mirrors `lib/useEdition.ts` — `useSyncExternalStore` over a module singleton —
 * because it is the same shape of per-reader global switch and the house pattern
 * should look the same twice.
 *
 * ONE DIFFERENCE, AND IT IS LOAD-BEARING. `useEdition`'s singleton is safe only
 * because its server snapshot is a CONSTANT: every server render of the edition
 * is "expert", and the boot script corrects it before paint. A chain is per
 * REQUEST. A warm lambda serves many visitors, so a module-level value written
 * during SSR would be one visitor's chain applied to the next one's render —
 * the exact failure the whole three-carrier design exists to prevent.
 *
 * So: the server snapshot stays the constant default, **no server component may
 * branch on this hook**, and every server-side read goes through
 * `serverChain()` (lib/serverChain.ts) or `requestChain(req)` (lib/envelope.ts)
 * instead. The client adopts the server's answer from the `data-chain` attribute
 * the layout renders, which needs no boot script precisely because the server
 * already knew it.
 */

import { useSyncExternalStore } from "react";

import {
  CHAIN_ATTR,
  CHAIN_COOKIE,
  CHAIN_MAX_AGE_S,
  DEFAULT_CHAIN,
  parseChainKey,
  type ChainKey,
} from "./chainChoice";

let current: ChainKey | null = null;
const listeners = new Set<() => void>();

function read(): ChainKey {
  if (current !== null) return current;
  if (typeof document === "undefined") return DEFAULT_CHAIN;
  current = parseChainKey(document.documentElement.getAttribute(CHAIN_ATTR)) ?? DEFAULT_CHAIN;
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useChain(): ChainKey {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_CHAIN);
}

/** Switch chains, and reload.
 *
 *  A HARD RELOAD, not `router.refresh()`. The refresh invalidates the server
 *  tree and leaves three client-side caches holding the previous chain: SWR's
 *  own store (its policy sets `keepPreviousData: true`, so the old numbers stay
 *  on screen by design), any prefetched RSC payload for another route, and
 *  in-flight polls. A reload is the only thing that guarantees none of them
 *  survives. Switching chains is a rare deliberate act by a partner, so it costs
 *  one page load on a path almost nobody takes — the same trade
 *  `next.config.mjs` already argues for its redirects.
 */
export function setChain(next: ChainKey): void {
  try {
    const secure = typeof location !== "undefined" && location.protocol === "https:";
    document.cookie =
      `${CHAIN_COOKIE}=${next}; path=/; max-age=${CHAIN_MAX_AGE_S}; samesite=lax` +
      (secure ? "; secure" : "");
  } catch {
    /* blocked storage: the reload below will simply land on the same chain */
  }
  current = next;
  for (const fn of listeners) fn();
  if (typeof location !== "undefined") location.reload();
}
