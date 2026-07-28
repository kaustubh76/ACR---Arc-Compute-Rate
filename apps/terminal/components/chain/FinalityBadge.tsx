"use client";

import { useEffect, useState } from "react";
import type { OnchainPrint } from "@/lib/types";

/* Settlement freshness, ticking: `posted 42s ago · finality <1s`. Uses the
   on-chain print's posted_at (block time, epoch seconds). Turns clay when the
   print is stale (older than ~2 refresh cycles). Sim mode renders the static
   finality fact instead of a fake age. */
export function FinalityBadge({
  onchain,
  live = true,
  staleAfterS = 7200,
  micro = false,
}: {
  onchain?: OnchainPrint | null;
  live?: boolean;
  staleAfterS?: number;
  micro?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);

  // Archived snapshot: the posted_at is frozen — don't tick a fake live age.
  if (onchain?.posted_at && !live) {
    return (
      <span className="chip chip-sim" style={micro ? { fontSize: 9.5, padding: "2px 8px" } : undefined}
        title="last on-chain print from the bundled snapshot — start the live API for real-time freshness">
        on-chain · archived
      </span>
    );
  }

  if (!onchain?.posted_at) {
    return (
      <span className="chip chip-sky" title="Malachite BFT — deterministic sub-second finality">
        finality &lt;1s
      </span>
    );
  }

  const age = Math.max(0, Math.floor(now - onchain.posted_at));
  const stale = age > staleAfterS;
  const label =
    age < 90 ? `${age}s` : age < 5400 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
  return (
    <span
      className={`chip ${stale ? "chip-breach" : "chip-teal"}`}
      style={micro ? { fontSize: 9.5, padding: "2px 8px" } : undefined}
      title={
        stale
          ? "the latest on-chain print is stale — settlement consumers should reject it"
          : "age of the settlement-grade print on ACROracle · finality is deterministic and sub-second"
      }
    >
      posted {label} ago{micro ? "" : " · finality <1s"}
    </span>
  );
}
