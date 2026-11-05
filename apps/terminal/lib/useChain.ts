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
 * So: the server snapshot never comes from module state, **no server component
 * may branch on this hook**, and every server-side read goes through
 * `serverChain()` (lib/serverChain.ts) or `requestChain(req)` (lib/envelope.ts)
 * instead. The client adopts the server's answer from the `data-chain` attribute
 * the layout renders, which needs no boot script precisely because the server
 * already knew it.
 *
 * THE SERVER SNAPSHOT IS THE LAYOUT'S ANSWER, CARRIED BY CONTEXT. A constant
 * default kept the singleton safe, but React also uses the server snapshot for
 * the HYDRATION render on the client, so every chain-keyed hook first rendered
 * for mainnet on a testnet page. Measured 2026-10-14: the testnet /curve fired
 * `/api/futures?chain=mainnet` beside `?chain=testnet` 1.4 s after load, and
 * `keepPreviousData` could show the mainnet desk until the testnet one landed.
 * `ChainProvider` takes the chain the layout read from the cookie as a PROP,
 * and a prop is per request, so the server render, the hydration render and
 * the first fetch all agree with `<html data-chain>`. Outside the provider (the
 * global error page renders its own document) the constant default stands.
 */

import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from "react";

import {
  CHAIN_ATTR,
  CHAIN_COOKIE,
  CHAIN_MAX_AGE_S,
  DEFAULT_CHAIN,
  parseChainKey,
  type ChainKey,
} from "./chainChoice";
import { hostSplit } from "./opsOrigin";

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

const ServedChain = createContext<ChainKey>(DEFAULT_CHAIN);

/** The chain this request was served for: `app/layout.tsx` wraps the page in it. */
export function ChainProvider({ chain, children }: { chain: ChainKey; children?: ReactNode }) {
  return createElement(ServedChain.Provider, { value: chain }, children);
}

export function useChain(): ChainKey {
  const served = useContext(ServedChain);
  return useSyncExternalStore(subscribe, read, () => served);
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
    // With the ops host split off (lib/opsOrigin.ts), the choice is scoped to
    // the parent domain so both hosts read the same one: an operator on testnet
    // must not land on the ops host's default chain with a key in hand. The
    // chain is not a credential, so sharing it costs nothing. Siblings that
    // share no parent (two vercel.app aliases) keep it per host. The host-only
    // cookie an earlier write left is cleared first, or it would shadow this.
    const split = hostSplit();
    const parent = split?.ops.hostname.endsWith(`.${split.site.hostname}`) ? split.site.hostname : null;
    if (parent) document.cookie = `${CHAIN_COOKIE}=; path=/; max-age=0`;
    document.cookie =
      `${CHAIN_COOKIE}=${next}; path=/; max-age=${CHAIN_MAX_AGE_S}; samesite=lax` +
      (parent ? `; domain=${parent}` : "") +
      (secure ? "; secure" : "");
  } catch {
    /* blocked storage: the reload below will simply land on the same chain */
  }
  current = next;
  for (const fn of listeners) fn();
  if (typeof location !== "undefined") location.reload();
}
