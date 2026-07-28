/* "Only computable on Arc" — the network's defining properties as product
   facts, in Arc's own vocabulary. Static truths; renders identically offline. */

import { chainFacts } from "@/lib/chain";
import type { ChainFactsData } from "@/lib/types";

export function ChainFactsStrip({ chain }: { chain?: ChainFactsData | null }) {
  const c = chainFacts(chain);
  return (
    <div className="facts">
      <div className="fact">
        <div className="fact-value">
          gas = <span className="gold">USDC</span>
        </div>
        <p className="fact-gloss">
          Fees are deterministic and dollar-denominated — so the cost to move the print 1bp is a
          number, not a distribution. The manipulation bound is only computable here.
        </p>
      </div>
      <div className="fact">
        <div className="fact-value">
          finality <span className="mono">&lt;1s</span>, deterministic
        </div>
        <p className="fact-gloss">
          Malachite BFT settles the moment it happens — clean tick timestamps for the volume-time
          clock, no reorg ambiguity in the tape.
        </p>
      </div>
      <div className="fact">
        <div className="fact-value">
          <span className="mono">{c.caip2}</span>
        </div>
        <p className="fact-gloss">
          {c.name} · every print, attestation and settlement in this terminal resolves on this
          chain — inspect any artifact on{" "}
          <a className="tx-link" href={c.explorer} target="_blank" rel="noreferrer">
            arcscan <span className="ext">↗</span>
          </a>
          .
        </p>
      </div>
    </div>
  );
}
