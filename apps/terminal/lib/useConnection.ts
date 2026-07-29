"use client";

/* Client wiring for the connection ladder (lib/connection.ts). One instance
   of the tracking state per tab: `lastLiveAtS` / `wakeStartedAtS` live at
   module scope so route changes don't reset the ladder.

   The wake ping: the first time a tab sees a non-live envelope, fire ONE
   /api/health fetch. Against the Render free tier that request starts the
   cold boot (~45s measured), and the ladder shows "waking the press" with a
   countdown instead of a mute "archived". */

import { useEffect } from "react";
import { connState, type ConnStatus } from "./connection";
import { useHealth, useOnchainPrints, useTerminal } from "./useLive";
import { useNow } from "./useNow";
import type { Envelope, TerminalData } from "./types";

let lastLiveAtS: number | null = null;
let wakeStartedAtS: number | null = null;
let wakePinged = false;

export interface Connection extends ConnStatus {
  env: Envelope<TerminalData>;
  /** the direct-read payload when the ladder is on the on-chain tier */
  onchain: ReturnType<typeof useOnchainPrints>;
}

export function useConnection(initial?: Envelope<TerminalData>): Connection {
  const env = useTerminal(initial);
  // Keep the health poll alive — it's the cheapest "is the press up" probe
  // and doubles as the recurring wake nudge while the backend boots.
  useHealth();
  const nowS = useNow();

  // Track liveness transitions in module state (not React state — the ladder
  // derives from useNow()'s 1 Hz tick, so no extra re-renders are needed).
  useEffect(() => {
    if (env.live) {
      lastLiveAtS = Math.floor(Date.now() / 1000);
      wakeStartedAtS = null;
      wakePinged = false; // a later outage gets a fresh wake attempt
    }
  }, [env.live, env.fetchedAt]);

  // One wake ping per outage, fired as soon as a resolved envelope says the
  // press is down (fetchedAt > 0 excludes the provisional first paint).
  useEffect(() => {
    if (env.live || env.fetchedAt === 0 || wakePinged) return;
    wakePinged = true;
    wakeStartedAtS = Math.floor(Date.now() / 1000);
    void fetch("/api/health").catch(() => {});
  }, [env.live, env.fetchedAt]);

  // Direct oracle reads only when the press isn't answering.
  const onchain = useOnchainPrints(!env.live && env.fetchedAt !== 0);
  const onchainOk =
    onchain?.live === true && Object.keys(onchain.data?.prints ?? {}).length > 0;

  const status = connState({
    live: env.live,
    fetchedAt: env.fetchedAt,
    lastLiveAtS,
    wakeStartedAtS,
    onchainOk,
    nowS,
  });

  return { ...status, env, onchain };
}
