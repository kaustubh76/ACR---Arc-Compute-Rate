"use client";

import { useState } from "react";

import { Ed } from "@/components/Ed";
import type { FloatVaultState } from "@/lib/float";
import { fmtPrice } from "@/lib/format";

/* Where the float is: the buffer, and the sleeves it earns in.

   THREE ROWS AND NOT A STACKED BAR. `.meter i` fills from the left edge, so a
   stack would need offsets that re-derive each row's start from the one before
   it — arithmetic that is wrong the first time a sleeve is absent. Three
   proportions of one total read the same and cannot drift.

   AN ABSENT SLEEVE IS NOT AN EMPTY ONE, and this is the distinction the panel
   exists to keep. The reserve ships as a null sleeve pending an allowlist and
   reverts by design; printing it as 0.00 USDC would describe a yield venue
   standing empty rather than one that is not live yet. `ACR_Float.md` is
   explicit about which of those is allowed on screen: a banner, never a mock.

   THE DRAW SLIDER IS WHY THIS PANEL HAS A CONTROL AT ALL. The paragraph at the
   bottom has always made the product's boldest claim — that a payment larger
   than the buffer pulls the exact shortfall back in the SAME transaction rather
   than waiting for a rebalance — and a reader had no way to see it happen. Now
   dragging the draw empties the buffer and then takes the difference out of the
   working sleeve, in gold, with the figure named. `.meter i` already carried a
   width transition, so the movement cost one CSS rule and no keyframe.

   AND IT IS A WHAT-IF, SAID THE SAME WAY THE RUNWAY SAYS IT. A slider that
   visually empties real on-chain balances is one careless label away from
   reading as a treasury draining in front of you, so the chip, the reset
   button and the "what would be left" figures are the runway's own idiom
   repeated rather than a second vocabulary for the same disclaimer.

   NO THIRD STATE ABOVE THE FREE FLOAT. There is no rung for an overdraw —
   `LADDER` runs PAUSED, UNKNOWN_AGENT, FROZEN, SELLER, REPLAY, UNITS,
   NO_PRINT, STALE, ROTATED, BAND, PER_REQUEST, DAILY_CAP and stops — so a
   draw past buffer-plus-sleeve has no refusal this panel could name without
   inventing one. The slider ends where the money does. Per-request and daily
   caps are real but they live on the AGENT (`FloatAgentStanding`), not on the
   vault's policy, and the ladder already shows them against one. */

function Row({
  label,
  value,
  total,
  fill,
  taken,
  takenFill,
}: {
  label: React.ReactNode;
  value: number;
  total: number;
  fill: string;
  /** How much of this row a what-if draw would take. */
  taken?: number;
  takenFill?: string;
}) {
  const gone = Math.min(Math.max(taken ?? 0, 0), value);
  const left = value - gone;
  const pctOf = (n: number) => (total > 0 ? Math.min(100, Math.max(0, (n / total) * 100)) : 0);
  const leftPct = pctOf(left);
  const gonePct = pctOf(gone);

  return (
    <div className="meter-row">
      <span className="label">{label}</span>
      <span className="meter">
        <i className={fill} style={{ width: `${leftPct}%` }} />
        {/* The band that left, immediately right of the band that stayed, so
            the row reads as a division rather than as a bar that shrank. */}
        {gone > 0 && takenFill ? (
          <i className={takenFill} style={{ left: `${leftPct}%`, width: `${gonePct}%` }} />
        ) : null}
      </span>
      <span className="num mono">{fmtPrice(left)}</span>
    </div>
  );
}

export function VaultMeter({ vault }: { vault: FloatVaultState }) {
  const buffer = vault.buffer_usdc ?? 0;
  const working = vault.working;
  const reserve = vault.reserve;
  const total = vault.total_usdc ?? buffer + (working?.value_usdc ?? 0) + (reserve?.value_usdc ?? 0);

  /* WHAT A DRAW CAN HONESTLY REACH. The reserve is excluded because it is not
     live, and an unread sleeve (`undefined`) is excluded too: showing a pull
     out of a balance the chain did not answer for would be the same invention
     the panel refuses everywhere else. The chip below already says a sleeve
     could not be read, and the slider simply stops at the buffer. */
  const pullable = working ? working.value_usdc : 0;
  const ceiling = buffer + pullable;
  const [draw, setDraw] = useState(0);

  /* The contract's own order, and the whole reason the slider exists: spend the
     buffer first, then pull exactly what is missing. */
  const want = Math.min(draw, ceiling);
  const fromBuffer = Math.min(want, buffer);
  const shortfall = Math.max(0, want - buffer);
  const fromWorking = Math.min(shortfall, pullable);

  const minTicket = vault.policy?.min_ticket_usdc ?? 0;
  const drawing = want > 0;

  return (
    <section className="section anchor-target" id="float">
      <div className="section-head">
        <h2 className="label">
          <Ed x="Where the float is" p="Where the money sits" />
        </h2>
        <span className="label">
          {drawing ? (
            <span className="chip chip-gold">
              <Ed x="what-if" p="what-if" />
            </span>
          ) : null}{" "}
          <span className="chip chip-teal">
            <Ed x="total free float" p="all of it" /> <span className="num">{fmtPrice(total)}</span>
          </span>
        </span>
      </div>

      <Row
        fill="fill-buffer"
        label={<Ed x="buffer" p="ready to pay" />}
        taken={fromBuffer}
        takenFill="fill-taken"
        total={total}
        value={buffer}
      />
      {working ? (
        <Row
          fill="fill-working"
          label={<Ed x="working sleeve" p="earning" />}
          taken={fromWorking}
          takenFill="fill-pull"
          total={total}
          value={working.value_usdc}
        />
      ) : null}
      {reserve ? (
        <Row
          fill="fill-reserve"
          label={<Ed x="reserve sleeve" p="held back" />}
          total={total}
          value={reserve.value_usdc}
        />
      ) : null}

      {ceiling > 0 ? (
        <>
          <div className="flow-controls">
            <label className="label">
              <Ed x="what-if: take this much out" p="what-if: take this much out" />{" "}
              <input
                aria-label="a what-if payment to draw from the treasury, in USDC"
                aria-valuetext={`${fmtPrice(want)} USDC`}
                max={ceiling}
                min={0}
                onChange={(e) => setDraw(Number(e.target.value))}
                step={ceiling / 100}
                type="range"
                value={want}
              />{" "}
              <b className="gold mono">{fmtPrice(want)}</b>
            </label>
            {drawing ? (
              <button className="chip" onClick={() => setDraw(0)} type="button">
                <Ed x="put it back" p="put it back" />
              </button>
            ) : null}
          </div>

          {/* The outcome, named. `aria-live` because the figures above it are
              bars: a reader who cannot see a gold band move needs the sentence
              that says what moved and how much. */}
          <p aria-live="polite" className="label mono" role="status">
            {!drawing ? (
              <Ed
                x="nothing drawn: the bars above are what the chain holds right now."
                p="nothing taken: the bars above are what is really there."
              />
            ) : shortfall === 0 ? (
              <Ed
                x="the buffer covers it on its own, and the sleeve is not touched."
                p="there is enough ready, so the savings are not touched."
              />
            ) : (
              <>
                <Ed x="the buffer is spent, so the sleeve gives up" p="the ready money runs out, so savings give up" />{" "}
                <span className="num gold">{fmtPrice(fromWorking)}</span>{" "}
                <Ed x="USDC in the same transaction" p="USDC in the same go" />
              </>
            )}
            {minTicket > 0 && drawing && want < minTicket ? (
              <>
                {" · "}
                <Ed x="under the vault's smallest ticket" p="smaller than the smallest payment allowed" />{" "}
                <span className="num">{fmtPrice(minTicket)}</span>
              </>
            ) : null}
          </p>
        </>
      ) : null}

      {/* `null` is read-and-not-live, which is the banner the product needs.
          `undefined` is not-read, and drawing the banner for it would announce
          a design decision on the strength of a rate limit. */}
      {reserve === null ? (
        <p className="label">
          <span className="chip chip-sim">
            <Ed x="reserve sleeve not live" p="the second pot is not switched on" />
          </span>
        </p>
      ) : null}
      {reserve === undefined || working === undefined ? (
        <p className="label">
          <span className="chip chip-sim">
            <Ed x="a sleeve could not be read just now" p="we could not read one of the pots" />
          </span>
        </p>
      ) : null}

      <Ed
        as="p"
        className="muted"
        style={{ fontSize: "var(--t-4)", marginTop: "var(--s-4)", maxWidth: "var(--measure)" }}
        x="Idle float sits in a real yield vault on this chain. The buffer is what is left for the next payment, and a payment larger than it pulls the exact shortfall back in the same transaction rather than waiting for a rebalance. Drag the draw above to watch that happen; it moves nothing on chain."
        p="Spare money earns in a real vault. What is left pays the next bill, and more is pulled back when one needs it. Drag the slider to see it."
      />
    </section>
  );
}
