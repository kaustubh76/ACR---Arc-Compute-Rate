/* "Only computable on Arc" — the network's defining properties as product
   facts, in Arc's own vocabulary. Static truths; renders identically offline. */

import { chainFacts } from "@/lib/chain";
import { Ed } from "@/components/Ed";
import type { ChainFactsData } from "@/lib/types";

export function ChainFactsStrip({ chain }: { chain?: ChainFactsData | null }) {
  const c = chainFacts(chain);
  return (
    <div className="facts">
      <div className="fact">
        <div className="fact-value">
          <Ed
            x={
              <>
                gas = <span className="gold">USDC</span>
              </>
            }
            p={
              <>
                fees = <span className="gold">dollars</span>
              </>
            }
          />
        </div>
        <Ed
          as="p"
          className="fact-gloss"
          x="Fees are deterministic and dollar-denominated, so the cost to move the print 1bp is a number — a bound only computable here."
          p="Fees are fixed and charged in dollars, so the bill for bending the rate is a number, not a guess — only Arc can print that."
        />
      </div>
      <div className="fact">
        <div className="fact-value">
          <Ed
            x={
              <>
                finality <span className="mono">&lt;1s</span>, deterministic
              </>
            }
            p={
              <>
                final in <span className="mono">&lt;1s</span>, for good
              </>
            }
          />
        </div>
        <Ed
          as="p"
          className="fact-gloss"
          x="Malachite BFT settles the moment it happens — clean timestamps, no reorg ambiguity in the tape."
          p="Payments are final in under a second — timestamps can be trusted, and history never gets rewritten."
        />
      </div>
      <div className="fact">
        <div className="fact-value">
          <span className="mono">{c.caip2}</span>
        </div>
        <Ed
          as="p"
          className="fact-gloss"
          x={
            <>
              {c.name} · every print and settlement resolves on this chain — inspect any artifact
              on{" "}
              <a className="tx-link" href={c.explorer} target="_blank" rel="noreferrer">
                arcscan <span className="ext">↗</span>
              </a>
              .
            </>
          }
          p={
            <>
              {c.name} · every rate and payment on this site lives on this network — check any of
              them on{" "}
              <a className="tx-link" href={c.explorer} target="_blank" rel="noreferrer">
                arcscan <span className="ext">↗</span>
              </a>
              .
            </>
          }
        />
      </div>
    </div>
  );
}
