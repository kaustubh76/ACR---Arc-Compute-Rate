"use client";

/* One shared 1 Hz clock for every ticking component (FinalityBadge et al).
   A module-level subscriber set drives a single interval that starts with the
   first subscriber and stops with the last — N badges cost one timer, and all
   tick in the same frame instead of drifting. */

import { useSyncExternalStore } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let nowS = Math.floor(Date.now() / 1000);

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  if (timer == null) {
    timer = setInterval(() => {
      nowS = Math.floor(Date.now() / 1000);
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return nowS;
}

// Server snapshot is a stable 0 — components must not render a wall-clock age
// during SSR (it would differ from the client and break hydration).
function getServerSnapshot(): number {
  return 0;
}

/** Epoch seconds, updating once per second while any subscriber is mounted.
 *  Returns 0 on the server — gate any age rendering on `now > 0`. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
