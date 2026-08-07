"use client";

import { refKind, txUrl } from "@/lib/chain";
import { shortAddr } from "@/lib/format";
import { Ed } from "@/components/Ed";
import { useEdition } from "@/lib/useEdition";

/* A settlement reference, rendered honestly: real tx hashes deep-link to the
   Arc explorer, Gateway batch references are labeled as such, and dev/sim
   markers wear a dashed SIM chip. Never an em-dash. */
export function TxLink({ txRef, explorer }: { txRef: string; explorer?: string }) {
  const kind = refKind(txRef);
  const plain = useEdition() === "plain";
  if (kind === "tx") {
    return (
      <a
        className="tx-link"
        href={txUrl(txRef, explorer)}
        target="_blank"
        rel="noreferrer"
        title={txRef}
      >
        {shortAddr(txRef)} <span className="ext">↗</span>
      </a>
    );
  }
  if (kind === "gateway-ref") {
    return (
      <span
        className="chip chip-sky"
        title={
          plain
            ? `Circle’s receipt number for this settled batch: ${txRef}`
            : `Circle Gateway settlement reference ${txRef}`
        }
      >
        <Ed x="gw · " p="receipt · " />
        {txRef.length > 14 ? `${txRef.slice(0, 8)}…` : txRef}
      </span>
    );
  }
  return (
    <span
      className="chip chip-sim"
      title={
        plain
          ? "a simulated payment: run the live paywall for real receipts"
          : "simulated settlement: run the live gate for real refs"
      }
    >
      {txRef}
    </span>
  );
}
