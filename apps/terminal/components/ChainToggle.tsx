"use client";

import { setChain, useChain } from "@/lib/useChain";
import type { ChainKey } from "@/lib/chainChoice";
import { Ed } from "@/components/Ed";

/* Which network this reader is on, and the way across.
 *
 * A SEGMENTED PAIR, LIKE THE EDITION TOGGLE BESIDE IT — and that reverses an
 * earlier, documented decision, so the reason belongs here. The first version
 * was deliberately asymmetric: a muted `testnet →` footnote on the default
 * chain and a gold chip off it, on the argument that a segmented pair would
 * claim the two networks were interchangeable. Measured in production on
 * 2026-10-12, the cost of that was a control that never named the network the
 * reader was ON (it only ever offered the other one), rendered at 55% ink with
 * no background, and carried no `aria-pressed` — so neither a sighted reader nor
 * a screen reader could read the current state off the control itself. The owner
 * asked for it to read as an active toggle, and the switch is now the same shape
 * as EXPERT | PLAIN: both options named, the current one lit.
 *
 * WHAT THE OLD DESIGN WAS RIGHT ABOUT, AND KEEPS. Being on testnet must still be
 * impossible to miss: its lit side is GOLD (the sandbox colour), not the navy a
 * lit MAINNET or EXPERT gets, so the two networks are visibly not equals even in
 * a symmetric control.
 *
 * THE LIT SIDE IS CSS'S JOB, keyed on `<html data-chain>`, which `app/layout.tsx`
 * server-renders from the request's cookie. Exactly how `.edition-seg` keys on
 * `data-edition`, and for the reason the original comment measured: `useChain()`'s
 * server snapshot is the constant default (a chain is per request, and a module
 * value written during SSR would leak one visitor's chain into the next render on
 * a warm lambda), so a React-driven highlight flashed the wrong network until
 * hydration.
 *
 * `aria-pressed` is the one thing CSS cannot set, so it comes from the `chain`
 * PROP — `initial.chain` from the masthead, the per-request envelope the layout
 * built from that same cookie. A prop is request-scoped, unlike the module value
 * above, so it is right on the first paint. The envelope field is optional, so
 * the hydrated value stands in when it is absent rather than a guessed default.
 *
 * AND IT IS STILL NOT THE DATELINE. `ChainStrip` keeps printing the network from
 * the payload the press actually answered with: this says what you ASKED for,
 * the dateline says what ANSWERED, and a reader can see any disagreement.
 */

export function ChainToggle({ chain }: { chain?: ChainKey }) {
  const hydrated = useChain();
  const active = chain ?? hydrated;

  // Clicking the lit side is a no-op: `setChain` hard-reloads (see
  // lib/useChain.ts for why it must), and reloading onto the same network would
  // be a page load that changes nothing.
  const pick = (next: ChainKey) => () => {
    if (next !== active) setChain(next);
  };

  return (
    <span className="segmented chain-seg" role="group" aria-label="network">
      <button
        type="button"
        className="seg-word on-main"
        aria-pressed={active === "mainnet"}
        title="the product's network · real USDC"
        onClick={pick("mainnet")}
      >
        <Ed x="mainnet" p="real network" />
      </button>
      <button
        type="button"
        className="seg-word on-test"
        aria-pressed={active === "testnet"}
        title="the partner sandbox · practice money"
        onClick={pick("testnet")}
      >
        <Ed x="testnet" p="practice network" />
      </button>
    </span>
  );
}
