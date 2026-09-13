"use client";

import { Ed } from "@/components/Ed";

/* The one sentence every instrument on /loop shares when the press is asleep.
 * The free tier naps between visits; the first press a judge makes is the one
 * that would time out. Said on the instrument, with the clock, instead of a dead
 * button — the same ladder the masthead pill reads (lib/connection.ts). */

export interface WakeState {
  waking: boolean;
  wakeS: number | null;
}

export function WakeNote({ wake }: { wake: WakeState }) {
  if (!wake.waking) return null;
  return (
    <span className="chip chip-gold" role="status">
      <span className="dot breathe" aria-hidden />
      <Ed x="the press is waking" p="our server is waking up" />
      {wake.wakeS != null ? <> · ~{Math.max(1, Math.round(wake.wakeS))}s</> : null}
    </span>
  );
}

/** What a button says when a call did not come back. */
export const RETRY_NOTE = { x: "no answer yet: the press naps between visits, so press again", p: "no answer yet: our server naps between visits, so press again" };
