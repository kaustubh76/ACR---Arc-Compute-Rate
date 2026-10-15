"use client";

/* The visitor's own values on /developers (their agent's wallet, their bill,
 * their MCP client), shared by every part of the page that runs something.
 *
 * ONE STORE, NOT ONE PER COMPONENT. The MCP section used to read localStorage
 * on its own, and the browser never fires `storage` in the tab that wrote, so
 * the endpoint table further down could not see a wallet typed into it until
 * something else re-rendered. Writes now notify every reader in this tab
 * directly, and the `storage` event still carries them to other tabs.
 *
 * Server snapshot is null, so the server render and hydration use the
 * defaults and the saved values arrive one render later, with no mismatch.
 * localStorage can throw (private mode, blocked site data): the values then
 * live in memory for the visit.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { PLAYGROUND_KEY, parseSaved, type PlaygroundInputs } from "./mcpPlayground";

let memory: string | null = null;
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return window.localStorage.getItem(PLAYGROUND_KEY) ?? memory;
  } catch {
    return memory;
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  window.addEventListener("storage", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", fn);
  };
}

function write(next: PlaygroundInputs): void {
  memory = JSON.stringify(next);
  try {
    window.localStorage.setItem(PLAYGROUND_KEY, memory);
  } catch {
    /* private mode: kept in memory for this visit */
  }
  for (const fn of listeners) fn();
}

/** The visitor's values, and a setter that merges a patch into them. */
export function usePlaygroundInputs(): [PlaygroundInputs, (patch: Partial<PlaygroundInputs>) => void] {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  const inputs = useMemo(() => parseSaved(raw), [raw]);
  const update = useCallback((patch: Partial<PlaygroundInputs>) => write({ ...parseSaved(read()), ...patch }), []);
  return [inputs, update];
}
