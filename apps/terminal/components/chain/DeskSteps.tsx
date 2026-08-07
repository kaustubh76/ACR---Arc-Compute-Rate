"use client";

import { Ed } from "@/components/Ed";
import { DESK_STEPS, deskStep, type DeskPhase } from "@/lib/deskPhase";

/* The walk to a first fill, as a rail.

   The desk shows one button at a time and the walk costs three PIN ceremonies
   with polling in between; a reader had no way to tell whether they were one
   step from trading or four, and the desk's only feedback was a single `note`
   line that a slow ceremony left blank. This says where they are, always.

   Presentational only — the phase machine lives in lib/deskPhase. */

/** Reader-facing names for each step. Expert copy is the desk's own
 *  vocabulary; plain copy says what the reader actually does. */
const LABELS: Array<{ x: string; p: string }> = [
  { x: "Account", p: "Make a wallet" },
  { x: "PIN", p: "Choose a PIN" },
  { x: "Stake", p: "Get 50 cents" },
  { x: "Collateral", p: "Put it up" },
  { x: "Trade", p: "Trade" },
];

export function DeskSteps({ phase, elapsedS }: { phase: DeskPhase; elapsedS?: number | null }) {
  const at = deskStep(phase);
  const total = DESK_STEPS.length;

  return (
    <div className="desk-steps-wrap">
      <ol className="desk-steps" aria-label="steps to your first trade">
        {LABELS.map((label, i) => {
          const done = i < at;
          const now = i === at;
          const cls = done ? "chip chip-teal" : now ? "chip chip-gold" : "chip";
          return (
            <li key={DESK_STEPS[i]} className={done ? "done" : now ? "now" : "todo"}>
              <span className={cls} aria-current={now ? "step" : undefined}>
                {now ? <i className="dot breathe" aria-hidden /> : null}
                {done ? <span aria-hidden>✓ </span> : null}
                <Ed x={label.x} p={label.p} />
                {/* The tick is aria-hidden and everything else about done-vs-
                    to-do is colour, so a screen reader heard the identical five
                    words at step 1 and at step 4. Clipped, not hidden — this
                    has to stay in the accessibility tree. */}
                <span className="sr-only">
                  {done ? " · done" : now ? " · you are here" : " · not started"}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {/* Narrate the wait rather than leaving a dead button. A Circle ceremony
          and the SCA provisioning behind it can take the better part of a
          minute, and silence there reads as breakage. */}
      <p className="desk-steps-cap mono muted">
        <Ed x={`step ${at + 1} of ${total}`} p={`step ${at + 1} of ${total}`} />
        {elapsedS != null && elapsedS >= 5 ? (
          <>
            {` · ${Math.round(elapsedS)}s · `}
            <Ed
              x="ceremonies can take up to a minute"
              p="this can take up to a minute, so keep the page open"
            />
          </>
        ) : null}
      </p>
    </div>
  );
}
