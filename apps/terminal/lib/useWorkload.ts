"use client";

/* The workload store — the useEdition mold (module singleton over
 * useSyncExternalStore), the useDeskAddress hydration posture.
 *
 * Two house patterns exist for per-reader state and this deliberately takes
 * the second. The edition uses a pre-paint boot script because it swaps
 * WORDS, which can be dual-rendered server-side and picked by CSS. The
 * workload produces NUMBERS computed from live marks; there is nothing to
 * dual-render, so a boot script would buy no flash-avoidance at all. The
 * figures appear right after hydration, exactly as the reader's own fills do
 * on the tape (lib/useDeskAddress.ts) — do not "upgrade" this to a boot
 * script later; it cannot help here.
 *
 * Unlike useDeskAddress there is no 5s poll: that hook watches a key ANOTHER
 * component writes mid-session, while this key has exactly one writer, below.
 * A listener set gives same-tab subscribers (the masthead chip) the update
 * the instant the editor saves, with no polling lag on camera.
 */

import { useSyncExternalStore } from "react";
import { WORKLOAD_KEY, parseWorkload, type Workload } from "./workload";

type Listener = () => void;

const listeners = new Set<Listener>();
let workload: Workload | null = null;
let adopted = false; // localStorage read at most once, on first client snapshot

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): Workload | null {
  if (!adopted && typeof window !== "undefined") {
    adopted = true;
    try {
      workload = parseWorkload(localStorage.getItem(WORKLOAD_KEY));
    } catch {
      workload = null; // private mode — per-visit memory only
    }
  }
  return workload;
}

function getServerSnapshot(): Workload | null {
  // Always null: the server HTML is identical for every reader, which is what
  // keeps hydration honest. Personalized lines render only after mount.
  return null;
}

/** The sole writer. null clears the profile entirely. */
export function setWorkload(next: Workload | null): void {
  if (typeof window === "undefined") return;
  adopted = true;
  workload = next;
  try {
    if (next) localStorage.setItem(WORKLOAD_KEY, JSON.stringify(next));
    else localStorage.removeItem(WORKLOAD_KEY);
  } catch {
    /* private mode — the session still works, it just forgets on reload */
  }
  listeners.forEach((l) => l());
}

/** The reader's declared workload; null on the server and until one is set. */
export function useWorkload(): Workload | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
