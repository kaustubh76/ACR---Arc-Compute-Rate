"use client";

/* The edition store — a module singleton in the useNow.ts mold, not a context.
   The boot script (lib/edition.ts) writes the <html> attribute pre-paint; the
   first client snapshot adopts that verdict, and from then on setEdition() is
   the sole writer of attribute, storage, and module state — CSS and React can
   never disagree. Server snapshot is a stable "expert": server HTML carries
   both copies and CSS picks, so no component may branch its markup on this
   hook (words only — see components/Ed.tsx for the dual-render primitive). */

import { useSyncExternalStore } from "react";
import {
  EDITION_ATTR,
  EDITION_KEY,
  EDITION_TURN_ATTR,
  type Edition,
  parseEdition,
} from "./edition";

type Listener = () => void;

const listeners = new Set<Listener>();
let edition: Edition = "expert";
let adopted = false; // boot-script verdict read at most once
let turnTimer: ReturnType<typeof setTimeout> | null = null;

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): Edition {
  if (!adopted && typeof document !== "undefined") {
    adopted = true;
    edition = parseEdition(document.documentElement.getAttribute(EDITION_ATTR)) ?? "expert";
  }
  return edition;
}

function getServerSnapshot(): Edition {
  return "expert";
}

/** Flip the paper. Writes the <html> attribute (CSS swaps the copy), pulses
 *  the transient turn attribute (the re-setting-type settle), persists the
 *  choice, and notifies subscribers. */
export function setEdition(next: Edition): void {
  if (typeof document === "undefined") return;
  if (getSnapshot() === next) return;
  edition = next;
  adopted = true;

  const root = document.documentElement;
  if (next === "plain") root.setAttribute(EDITION_ATTR, "plain");
  else root.removeAttribute(EDITION_ATTR);

  // One settle per toggle, debounced against double-clicks.
  root.setAttribute(EDITION_TURN_ATTR, "");
  if (turnTimer != null) clearTimeout(turnTimer);
  turnTimer = setTimeout(() => {
    root.removeAttribute(EDITION_TURN_ATTR);
    turnTimer = null;
  }, 480);

  try {
    localStorage.setItem(EDITION_KEY, next);
  } catch {
    /* private mode — per-visit memory only */
  }
  listeners.forEach((l) => l());
}

export function toggleEdition(): void {
  setEdition(getSnapshot() === "plain" ? "expert" : "plain");
}

/** The current edition; "expert" on the server. Use for attribute strings
 *  (title=, aria-label) that cannot dual-render — hydration is safe because
 *  React reconciles a differing client snapshot with a silent re-render. */
export function useEdition(): Edition {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
