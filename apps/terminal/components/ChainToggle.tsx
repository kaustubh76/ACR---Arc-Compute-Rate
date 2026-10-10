"use client";

import { setChain, useChain } from "@/lib/useChain";
import { Ed } from "@/components/Ed";

/* Which network this reader is on, and the way back.
 *
 * ASYMMETRIC ON PURPOSE, and that is the design decision. The edition toggle
 * beside it is a `.segmented` pair because expert and plain are equal and
 * permanent — neither is a detour. The two networks are not equal: the product
 * is the default one and the other is a partner sandbox. A second segmented
 * control here would claim they were interchangeable, and would be the additive,
 * panel-shaped chrome this project rejects. So the control's weight tracks the
 * RISK OF BEING ON THE WRONG ONE: a muted footnote on the default, a loud gold
 * chip off it, because a partner demoing play money must not be able to miss it.
 *
 * BOTH LABELS ARE RENDERED AND CSS PICKS ONE, which is not a style choice — it
 * is the only correct way to do this here. `useChain()`'s server snapshot is the
 * constant default, deliberately: a chain is per request, and a module value
 * written during SSR would be one visitor's chain applied to the next one's
 * render on a warm lambda. So the server cannot branch on it, and a React-driven
 * label flashed "switch to testnet" at a reader who was already on testnet until
 * hydration corrected it — a flash of wrong state on the one control whose whole
 * job is to make the wrong network obvious. Measured in the built app, not
 * reasoned about.
 *
 * The fix is the house mechanism: `app/layout.tsx` server-renders
 * `<html data-chain>`, both branches ship, and `globals.css` reveals the right
 * one. Exactly how `.ed-x` / `.ed-p` already serve the edition, and for exactly
 * the same reason.
 *
 * AND IT IS NOT THE DATELINE. `ChainStrip` keeps printing the network from the
 * payload the press actually answered with. Deliberate redundancy: this says what
 * you ASKED for, the dateline says what ANSWERED, and a reader can see any
 * disagreement. Making the dateline the control would collapse the fact and the
 * switch into one object and destroy the cross-check.
 */

export function ChainToggle() {
  // Read only for the CLICK, never for the label. After hydration this is the
  // real chain, which is all the handler needs; the label is CSS's job above.
  const chain = useChain();

  return (
    <button
      type="button"
      className="chain-switch"
      onClick={() => setChain(chain === "mainnet" ? "testnet" : "mainnet")}
      aria-label="switch network"
    >
      <span className="chain-on-default">
        <Ed x="testnet →" p="practice network →" />
      </span>
      <span className="chain-off-default">
        <Ed x="testnet · leave →" p="practice network · go back →" />
      </span>
    </button>
  );
}
