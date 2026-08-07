"use client";

/* Small chain-identity chips woven through every page. */

import { Ed } from "@/components/Ed";
import { useEdition } from "@/lib/useEdition";

/** Honest mode label: every surface says whether its data is real. The
 *  "onchain" tier is the direct-read rung of the connection ladder — the
 *  press is down but the number came straight from ACROracle just now. */
export function SimBadge({ mode }: { mode: "sim" | "dev" | "live" | "onchain" }) {
  const plain = useEdition() === "plain";
  if (mode === "live") return <span className="chip chip-teal">live</span>;
  if (mode === "onchain")
    return (
      <span
        className="chip chip-teal"
        title={
          plain
            ? "read straight off the blockchain by this page: our server is down, the record is not"
            : "read straight from ACROracle by this terminal: the index API is down, the record is not"
        }
      >
        direct read
      </span>
    );
  if (mode === "dev")
    return (
      <span className="chip chip-sky">
        <Ed x="dev gate" p="practice paywall" />
      </span>
    );
  return (
    <span
      className="chip chip-sim"
      title={
        plain
          ? "a saved simulation: start the live server for live data"
          : "bundled simulation: start the index API for live data"
      }
    >
      sim
    </span>
  );
}
