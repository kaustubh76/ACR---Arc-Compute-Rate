"use client";

import { useEffect, useRef, useState } from "react";

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
   register here would flash on hydration. Five plain nouns in the picture, and
   the sentence that explains them underneath where it dual-renders properly.

   THE BENCHMARK IS IN THE PICTURE BECAUSE THE BENCHMARK IS THE PRODUCT. The
   diagram used to show the money moving and leave out the one check that makes
   this treasury different from a wallet with a limit: the price the vault reads
   off the chain and recomputes the fair total from, before it pays anything.
   The ladder tests it at rung 10 and a tape row proves it at step 1, and this
   is the picture a reader meets first. It hangs over the treasury rather than
   the rail because the treasury is what does the checking. */

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
  fair,
  step,
}: {
  l: Layout;
  cls: string;
  vault: FloatVaultState;
  paying: boolean;
  jit: boolean;
  /** The fair total the newest payment was checked against. */
  fair?: number;
  /** -1 when idle, otherwise how far the replay has walked. Cumulative: a
   *  station that has lit stays lit, as `LoopFlow`'s stations do. */
  step: number;
}) {
  const buffer = vault.buffer_usdc;
  const working = vault.working;
  const boxH = 52;
  const sideY = l.railY - boxH / 2;
  const agentY = 12;
  const agentH = 40;
  const sleeveY = l.h - 42;
  /* Directly over the treasury, in its column and at the agent's height. The
     agent is centred on `midX` and spans `bw + 34`, so this column is free in
     both layouts: 16..132 against the agent's 245..395 wide, 4..100 against
     117..247 narrow. */
  const benchX = l.x1 - l.bw;
  const benchH = 38;

  return (
    <svg
      aria-label="the treasury checks the price against the benchmark, then pays the seller; the agent instructs and holds nothing"
      className={`money ${cls}${paying || step === 3 ? " paying" : ""}${jit ? " jit" : ""}`}
      role="img"
      style={{ ["--travel" as string]: `${l.x2 - l.x1}px` }}
      viewBox={`0 0 ${l.w} ${l.h}`}
    >
      <line className="rail" x1={l.x1} x2={l.x2} y1={l.railY} y2={l.railY} />

      {/* the agent, above, tethered by instruction only */}
      <line className="tether" x1={l.midX} x2={l.midX} y1={agentY + agentH} y2={l.railY} />
      <rect className={`node-box held${step >= 0 ? " on" : ""}`} height={agentH} rx={8} width={l.bw + 34} x={l.midX - (l.bw + 34) / 2} y={agentY} />
      <text className="node-label" x={l.midX - (l.bw + 34) / 2 + l.pad} y={agentY + l.gap}>
        agent
      </text>
      <text className="node-figure nil" x={l.midX - (l.bw + 34) / 2 + l.pad} y={agentY + l.gap + 15}>
        0.00 USDC
      </text>

      {/* the yield venue, below, joining the rail before the seller */}
      <line className="tether jit-leg" x1={l.midX} x2={l.midX} y1={l.railY} y2={sleeveY} />
      <rect className={`node-box${jit || step >= 2 ? " on" : ""}`} height={36} rx={8} width={l.bw + 34} x={l.midX - (l.bw + 34) / 2} y={sleeveY} />
      <text className="node-label" x={l.midX - (l.bw + 34) / 2 + l.pad} y={sleeveY + l.gap}>
        earning
      </text>
      <text className="node-figure" x={l.midX - (l.bw + 34) / 2 + l.pad} y={sleeveY + l.gap + 14}>
        {working ? `${fmtPrice(working.value_usdc)} USDC` : "not live"}
      </text>

      {/* the benchmark, above the treasury and tethered down to it */}
      <line className="tether" x1={benchX + l.bw / 2} x2={benchX + l.bw / 2} y1={agentY + benchH} y2={sideY} />
      <rect className={`node-box${step >= 1 ? " on" : ""}`} height={benchH} rx={8} width={l.bw} x={benchX} y={agentY} />
      <text className="node-label" x={benchX + l.pad} y={agentY + l.gap}>
        benchmark
      </text>
      <text className="node-figure" x={benchX + l.pad} y={agentY + l.gap + 14}>
        {fair === undefined ? "…" : `${fmtPrice(fair)} USDC`}
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
      <rect className={`node-box${step >= 3 ? " on" : ""}`} height={boxH} rx={8} width={l.bw} x={l.x2} y={sideY} />
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

/** How long each station holds before the next lights. `LoopFlow` uses 650ms
 *  for six stations; five want a little longer to be followed. */
const STEP_MS = 900;
/* FIVE BEATS, IN THE CONTRACT'S OWN ORDER: the agent asks, the print is read
   and the fair total recomputed, the shortfall is pulled if there is one, the
   seller is paid, the receipt is written. The walkthrough a tape row opens
   tells the same story, and it used to tell it in a different number of
   steps than the diagram above it. */
const LAST_STEP = 4;

export function MoneyPath({
  vault,
  paying,
  jitFunded,
  quoteUsdc,
  fairUsdc,
}: {
  vault: FloatVaultState;
  paying: boolean;
  /** Whether the newest actual payment pulled from the sleeve. */
  jitFunded?: boolean;
  /** What that payment cost, so the replay narrates a real number. */
  quoteUsdc?: number;
  /** What the chain itself said it should have cost. The pair is the product's
   *  whole claim, so the picture carries both rather than only what was paid. */
  fairUsdc?: number;
}) {
  /* "Funded just in time" is a property of a payment, not of a treasury. This
     used to light on the only proxy the diagram had — a working sleeve holding
     anything at all — and said so in a comment. The tape carries `jit_funded`
     per receipt now, so the leg lights on what the newest payment actually
     did, and falls back to the proxy only while the tape has not answered. */
  const jit = jitFunded ?? Boolean(vault.working && vault.working.value_usdc > 0);

  /* THE DIAGRAM REPLAYS A PAYMENT THAT HAPPENED, not a cartoon. Every number
     it narrates comes off the newest real receipt, and the sleeve step is
     SKIPPED when that payment was not funded that way rather than animated
     anyway. A diagram that always tells the same story is decoration.

     Cumulative lighting and a `setInterval` cleared on unmount, as
     `components/loop/LoopFlow.tsx` does. Under reduced motion the dot does not
     travel, but the walk still advances and ends lit: the information is in
     the stations, and only the dot was ever motion. */
  const [step, setStep] = useState(-1);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const playing = step >= 0 && step < LAST_STEP;
  function play() {
    if (playing) return;
    setStep(0);
    let i = 0;
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      i += 1;
      if (i > LAST_STEP) {
        if (timer.current) clearInterval(timer.current);
        return;
      }
      setStep(i);
    }, STEP_MS);
  }

  return (
    <>
      <Diagram cls="money-wide" fair={fairUsdc} jit={jit} l={WIDE} paying={paying} step={step} vault={vault} />
      <Diagram cls="money-narrow" fair={fairUsdc} jit={jit} l={NARROW} paying={paying} step={step} vault={vault} />

      <div className="flow-controls">
        <button
          aria-pressed={playing}
          className={`chip${playing ? " chip-gold" : ""}`}
          onClick={play}
          type="button"
        >
          {playing ? <i aria-hidden className="dot breathe" /> : null}
          <Ed x="Watch a payment" p="Watch a payment" />
        </button>
        {step < 0 ? null : (
          <span className="label muted">
            <Ed x="replaying the newest one on the tape" p="replaying the latest one below" />
          </span>
        )}
      </div>

      {step < 0 ? null : (
        <div aria-live="polite" className="flow-log" role="status">
          {step === 0 ? (
            <Ed
              x="the agent asks. Its own wallet holds nothing, now and at the end."
              p="the robot asks. Its own wallet is empty, now and after."
            />
          ) : step === 1 ? (
            /* THE BEAT THE DIAGRAM WAS MISSING, and the only one that is about
               the price rather than the money. Both numbers, because either
               alone says nothing: a fair total is not a verdict and a quote is
               not a check. The chain computed both. */
            <>
              <Ed
                x="the vault reads the print and recomputes the fair total itself"
                p="the vault looks up the real rate and works the total out itself"
              />
              {fairUsdc === undefined ? null : (
                <>
                  {": "}
                  <Ed x="fair" p="fair" /> <span className="num">{fmtPrice(fairUsdc)}</span>
                  {quoteUsdc === undefined ? null : (
                    <>
                      {", "}
                      <Ed x="asked" p="asked" /> <span className="num">{fmtPrice(quoteUsdc)}</span>
                    </>
                  )}{" "}
                  USDC
                </>
              )}
            </>
          ) : step === 2 ? (
            jit ? (
              <Ed
                x="the shortfall leaves the yield venue, in this same transaction."
                p="the missing part comes out of savings, in the same go."
              />
            ) : (
              <Ed
                x="nothing is pulled: the buffer covered this one on its own."
                p="nothing is taken from savings: there was enough ready."
              />
            )
          ) : step === 3 ? (
            <>
              <Ed x="the treasury pays the seller" p="the treasury pays the shop" />
              {quoteUsdc === undefined ? null : (
                <>
                  {" "}
                  <span className="num">{fmtPrice(quoteUsdc)}</span> USDC
                </>
              )}
            </>
          ) : (
            <Ed
              x="the receipt is written, and the agent's wallet still holds nothing."
              p="the receipt is written, and the robot still holds nothing."
            />
          )}
        </div>
      )}
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: "var(--t-4)", marginTop: 0, maxWidth: "var(--measure)" }}
        x="The treasury pays the seller, but only after it checks the asking price against the benchmark above it and recomputes the fair total from the chain's own print. The agent sends the instruction down the dashed line and holds nothing at either end, which is the one property this whole design exists to keep. Idle money earns underneath, and a payment short of the buffer pulls the exact shortfall up and pays in the same transaction."
        p="The treasury checks the price is fair before it pays the shop. The robot only asks; it never holds the money. Spare money earns below."
      />
    </>
  );
}
