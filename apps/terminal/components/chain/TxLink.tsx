import { refKind, txUrl } from "@/lib/chain";
import { shortAddr } from "@/lib/format";

/* A settlement reference, rendered honestly: real tx hashes deep-link to the
   Arc explorer, Gateway batch references are labeled as such, and dev/sim
   markers wear a dashed SIM chip. Never an em-dash. */
export function TxLink({ txRef, explorer }: { txRef: string; explorer?: string }) {
  const kind = refKind(txRef);
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
      <span className="chip chip-sky" title={`Circle Gateway settlement reference ${txRef}`}>
        gw · {txRef.length > 14 ? `${txRef.slice(0, 8)}…` : txRef}
      </span>
    );
  }
  return (
    <span className="chip chip-sim" title="simulated settlement — run the live gate for real refs">
      {txRef}
    </span>
  );
}
