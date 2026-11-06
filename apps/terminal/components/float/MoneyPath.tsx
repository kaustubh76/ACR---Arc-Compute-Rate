"use client";

import { Ed } from "@/components/Ed";
import type { FloatVaultState } from "@/lib/float";
import { fmtPrice } from "@/lib/format";

/* Where the money goes, and where it never goes.

   THE AGENT HANGS ABOVE THE RAIL AND IS NOT ON IT. That is the whole diagram.
   The treasury pays the seller; the agent sends an instruction down a dashed
   tether and holds nothing, before or after. `scripts/float_rehearse.py` asserts
   exactly that at both ends of a run and the contract's own test is called
   `test_the_agents_own_wallet_holds_nothing_before_and_after` — so the job here
   is to show it, not to claim it.

   THE SLEEVE'S LEG JOINS THE RAIL BEFORE THE SELLER, because that is the order
   the chain can prove. A payment short of buffer pulls the exact shortfall out
   of the yield venue and pays in the SAME transaction, and the ordering is
   proven by log index inside one receipt rather than by a trace (Arc's RPC
   serves no `debug_traceTransaction`).

   TWO LAYOUTS, AND THE NARROW ONE IS NOT OPTIONAL. SVG text is sized in user
   units, so one 640-wide viewBox squeezed into a 375px screen renders 9px
   labels at about 5px. Measured in a headless browser at 375: the diagram was
   present, correct and unreadable. `viewBox` is not a CSS property, so the fix
   is two compositions in the DOM with a media query choosing one — pure CSS,
   no hydration flash, the same trick the edition system uses.

   THE LABELS ARE REGISTER-NEUTRAL ON PURPOSE. SVG `<text>` cannot host an
   `<Ed>`, and `useEdition()` resolves to expert on the server, so a dual
   register here would flash on hydration. Four plain nouns in the picture, and
   the sentence that explains them underneath where it dual-renders properly. */

type Layout = {
  w: number;
  h: number;
  /** box width, and the x of each end box */
  bw: number;
  railY: number;
  x1: number;
  x2: number;
  /** the vertical centre the agent and the sleeve hang from */
  midX: number;
  pad: number;
  gap: number;
};

/* Wide: the rail runs the full width with room for 150-unit boxes. Narrow:
   the same composition in a 360-unit box, so a 375px screen renders the text
   at roughly its own pixel size. */
const WIDE: Layout = { w: 640, h: 200, bw: 116, railY: 120, x1: 132, x2: 508, midX: 320, pad: 14, gap: 18 };
const NARROW: Layout = { w: 360, h: 210, bw: 96, railY: 126, x1: 100, x2: 264, midX: 182, pad: 10, gap: 16 };

function Diagram({
  l,
  cls,
  vault,
  paying,
  jit,
}: {
  l: Layout;
  cls: string;
  vault: FloatVaultState;
  paying: boolean;
  jit: boolean;
}) {
  const buffer = vault.buffer_usdc;
  const working = vault.working;
  const boxH = 52;
  const sideY = l.railY - boxH / 2;
  const agentY = 12;
  const agentH = 40;
  const sleeveY = l.h - 42;

  return (
    <svg
      aria-label="the treasury pays the seller; the agent instructs and holds nothing"
      className={`money ${cls}${paying ? " paying" : ""}${jit ? " jit" : ""}`}
      role="img"
      style={{ ["--travel" as string]: `${l.x2 - l.x1}px` }}
      viewBox={`0 0 ${l.w} ${l.h}`}
    >
      <line className="rail" x1={l.x1} x2={l.x2} y1={l.railY} y2={l.railY} />

      {/* the agent, above, tethered by instruction only */}
      <line className="tether" x1={l.midX} x2={l.midX} y1={agentY + agentH} y2={l.railY} />
      <rect className="node-box held" height={agentH} rx={8} width={l.bw + 34} x={l.midX - (l.bw + 34) / 2} y={agentY} />
      <text className="node-label" x={l.midX - (l.bw + 34) / 2 + l.pad} y={agentY + l.gap}>
        agent
      </text>
      <text className="node-figure nil" x={l.midX - (l.bw + 34) / 2 + l.pad} y={agentY + l.gap + 15}>
        0.00 USDC
      </text>

      {/* the yield venue, below, joining the rail before the seller */}
      <line className="tether jit-leg" x1={l.midX} x2={l.midX} y1={l.railY} y2={sleeveY} />
      <rect className={`node-box${jit ? " on" : ""}`} height={36} rx={8} width={l.bw + 34} x={l.midX - (l.bw + 34) / 2} y={sleeveY} />
      <text className="node-label" x={l.midX - (l.bw + 34) / 2 + l.pad} y={sleeveY + l.gap}>
        earning
      </text>
      <text className="node-figure" x={l.midX - (l.bw + 34) / 2 + l.pad} y={sleeveY + l.gap + 14}>
        {working ? `${fmtPrice(working.value_usdc)} USDC` : "not live"}
      </text>

      {/* the treasury */}
      <rect className="node-box on" height={boxH} rx={8} width={l.bw} x={l.x1 - l.bw} y={sideY} />
      <text className="node-label" x={l.x1 - l.bw + l.pad} y={sideY + l.gap + 1}>
        treasury
      </text>
      <text className="node-figure" x={l.x1 - l.bw + l.pad} y={sideY + l.gap + 19}>
        {buffer === undefined ? "…" : `${fmtPrice(buffer)} USDC`}
      </text>

      {/* the seller */}
      <rect className="node-box" height={boxH} rx={8} width={l.bw} x={l.x2} y={sideY} />
      <text className="node-label" x={l.x2 + l.pad} y={sideY + l.gap + 1}>
        seller
      </text>
      <text className="node-figure" x={l.x2 + l.pad} y={sideY + l.gap + 19}>
        {vault.receipts === undefined ? "…" : `${vault.receipts} paid`}
      </text>

      <circle className="money-dot" cx={l.x1} cy={l.railY} r={4} />
    </svg>
  );
}

export function MoneyPath({ vault, paying }: { vault: FloatVaultState; paying: boolean }) {
  /* "Funded just in time" is a property of a payment, not of a treasury, and
     this surface has no receipt in hand — so the leg lights on the only honest
     proxy available here: a working sleeve that holds value at all. The
     receipts tape is where a specific payment gets to say it was funded that
     way. */
  const jit = Boolean(vault.working && vault.working.value_usdc > 0);

  return (
    <>
      <Diagram cls="money-wide" jit={jit} l={WIDE} paying={paying} vault={vault} />
      <Diagram cls="money-narrow" jit={jit} l={NARROW} paying={paying} vault={vault} />
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: "var(--t-4)", marginTop: 0, maxWidth: "var(--measure)" }}
        x="The treasury pays the seller. The agent sends the instruction down the dashed line and holds nothing at either end, which is the one property this whole design exists to keep. Idle money earns underneath, and a payment short of the buffer pulls the exact shortfall up and pays in the same transaction."
        p="The treasury pays the shop. The robot only asks; it never holds the money. Spare money earns below, and comes up when a bill needs it."
      />
    </>
  );
}
