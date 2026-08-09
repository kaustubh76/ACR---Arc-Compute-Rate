"use client";

import { fmtInt, fmtPrice, serviceName } from "@/lib/format";
import { useEdition } from "@/lib/useEdition";
import { linear } from "./scale";
import { useCrosshair } from "./useCrosshair";
import type { CurvePoint, PrintRow } from "@/lib/types";

/* The maker's quote corridor: for each index, the WHOLE term structure — every
   tenor's bid-to-ask interval as a share of spot, gold tick at each mid, the
   mids joined so the curve's shape is the thing you see first.

   It used to draw `curve[0]` and stop. Three quarters of a term structure was
   fetched on every load and thrown away, and a page whose entire subject is
   "machine commerce has a forward curve" showed one point of it against a
   dashed line pinned at spot by construction. Whether the desk is quoting
   forward prices ABOVE or BELOW spot, and by how much it steepens, is the
   information here; a lone front-tenor interval cannot carry it.

   The mid is NOT pinned to spot. The A-S reservation price leans on inventory
   (a short book quotes up, a long book down), so the gold dots sit deliberately
   off the dashed line and the row header names that lean in bp, so it cannot be
   mistaken for a drawing fault.

   The print's own confidence interval is drawn as a band behind everything: it
   is the honest backdrop for a quote corridor, because a spread narrower than
   the interval it is quoted around is a spread quoting noise.

   A reading line (the same crosshair the other charts use) scrubs the price
   axis: the axis is continuous %-of-spot, so we sample it at RES steps and let
   `useCrosshair` resolve the cursor to a step — pointer OR ←/→/Home/End/Esc —
   then print the implied price per index into a fixed caption row above. */

const W = 760;
/* Vertical budget per index: a header line, then one lane per tenor, then air.
   Was a flat 76 when only one tenor was drawn. */
const LANE_H = 19;
const HEAD_H = 26;
const ROW_GAP = 20;
const PAD_TOP = 34;
const PAD_BOTTOM = 14;
/* The SAME gutters HistoryChart and FuturesMarkChart use. Every chart here
   shares viewBox width 760 and renders at the same CSS width, so one user unit
   is one screen unit in all of them — which means a different `left` is a
   visible offset, not a detail. This was {left:16,right:16}: a 56-unit shift
   against the mark chart two sections below it on /curve, with the corridor's
   band 728 units wide against everything else's 676.

   The gutter is now OCCUPIED, by the tenor labels. Reserving 72 units and
   leaving them blank still left this chart's visible ink starting 72 units in
   while the mark chart's y-labels ran leftwards into the same gutter from 64 —
   two stacked charts, ruled identically, whose ink began in different places. */
const M = { left: 72, right: 12 };
const RES = 120; // price-axis sampling resolution for the reading line

/** Front tenor solid, back tenors progressively quieter, so the near quote
 *  reads first and the far ones give it context rather than competing. */
function laneOpacity(j: number, n: number): number {
  return n <= 1 ? 1 : 1 - (j / (n - 1)) * 0.5;
}

function tenorLabel(c: CurvePoint): string {
  return `${c.tenor_weeks}w`;
}

export function QuoteCorridor({
  prints,
  only,
}: {
  prints: Record<string, PrintRow>;
  only?: string;
}) {
  // SVG <text> cannot host the <Ed> span pair — swap words via the hook.
  const plain = useEdition() === "plain";
  // Hooks run before any early return; the x-range is fixed, so it's safe here.
  const { idx, svgRef, onPointerMove, onPointerLeave, onKeyDown } = useCrosshair(
    RES,
    M.left,
    W - M.right,
  );
  const rows = Object.values(prints).filter(
    (p) => p.curve?.length && p.value > 0 && (!only || p.index_id === only),
  );
  if (!rows.length) return <div className="awaiting">Awaiting quotes</div>;

  const pct = (p: PrintRow, v: number) => (100 * v) / p.value;
  /** How far the maker's mid sits from spot, in bp. Positive = quoting above
   *  spot (a short book leaning the reservation price up). */
  const skewBp = (p: PrintRow, mid: number) => (10000 * (mid - p.value)) / p.value;
  /** Front tenor to back tenor, in bp: the slope of the curve. Positive is
   *  contango (forward dearer than near), negative is backwardation. */
  const slopeBp = (p: PrintRow) => {
    const c = p.curve;
    return c.length < 2 ? null : (10000 * (c[c.length - 1].mid - c[0].mid)) / p.value;
  };

  // Domain spans EVERY tenor now, plus the print's own interval, so nothing
  // drawn can fall outside the axis.
  const xs: number[] = [];
  for (const p of rows) {
    for (const c of p.curve) xs.push(pct(p, c.bid), pct(p, c.ask));
    if (p.ci_lo > 0) xs.push(pct(p, p.ci_lo));
    if (p.ci_hi > 0) xs.push(pct(p, p.ci_hi));
  }
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const pad = (hi - lo) * 0.08 || 5;
  const x = linear([lo - pad, hi + pad], [M.left, W - M.right]);

  const rowH = (p: PrintRow) => HEAD_H + p.curve.length * LANE_H + ROW_GAP;
  const rowTops: number[] = [];
  let cursorY = PAD_TOP;
  for (const p of rows) {
    rowTops.push(cursorY);
    cursorY += rowH(p);
  }
  const H = cursorY + PAD_BOTTOM;

  // Resolve the crosshair step → the %-of-spot the cursor sits on, and the
  // implied price that reads out per index.
  const cursorPct = idx == null ? null : lo - pad + (idx / (RES - 1)) * (hi + pad - (lo - pad));
  const lineX = cursorPct == null ? null : x(cursorPct);
  const restingCaption = rows
    .map((p) => {
      const s = slopeBp(p);
      if (s == null) return `${p.index_id} ${fmtPrice(p.curve[0].mid)}`;
      /* Flat needs its own branch, and not as a nicety: `s > 0` sent an exactly
         zero slope down the else, so a book with no inventory published
         "backwardation −0.0 bp" — a market claim, stated with a sign, about a
         curve that has no slope. A flat book is the normal state for an index
         the maker holds nothing on, so this reads on production today. Rounds
         to the same 0.1 bp the number is printed at, so the words can never
         disagree with the figure beside them. */
      if (Math.abs(s) < 0.05) return `${p.index_id} ${plain ? "same later" : "flat"} 0.0 bp`;
      const shape = s > 0 ? (plain ? "dearer later" : "contango") : plain ? "cheaper later" : "backwardation";
      return `${p.index_id} ${shape} ${s > 0 ? "+" : "−"}${Math.abs(s).toFixed(1)} bp`;
    })
    .join(" · ");
  const caption =
    cursorPct == null
      ? restingCaption
      : `${cursorPct.toFixed(1)}% of spot · ` +
        rows.map((p) => `${p.index_id} ${fmtPrice((p.value * cursorPct) / 100)}`).join(" · ");

  return (
    <>
      <div className="reading" aria-hidden>
        {caption}
      </div>
      <svg
        ref={svgRef}
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        tabIndex={0}
        role="img"
        aria-label="Quote corridor: every tenor's bid to ask as a share of spot, per index"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
      >
        {/* The left rule the other charts draw. Without it this chart had no
            visible edge to align to, so even at the right gutter the eye had
            nothing to line up against the mark chart below. */}
        <line x1={M.left} y1={PAD_TOP - 14} x2={M.left} y2={H - PAD_BOTTOM} stroke="var(--rule)" />

        {/* spot — the reference everything is quoted around */}
        <line
          x1={x(100)}
          y1={PAD_TOP - 14}
          x2={x(100)}
          y2={H - PAD_BOTTOM}
          stroke="var(--ink-45)"
          strokeWidth={0.75}
          strokeDasharray="3 4"
        />
        <text x={x(100)} y={PAD_TOP - 20} textAnchor="middle">
          {plain ? "TODAY’S RATE" : "SPOT"}
        </text>

        {rows.map((p, i) => {
          const top = rowTops[i];
          const laneY = (j: number) => top + HEAD_H + j * LANE_H + LANE_H / 2;
          const front = p.curve[0];
          const skew = skewBp(p, front.mid);
          const ciLo = p.ci_lo > 0 ? x(pct(p, p.ci_lo)) : null;
          const ciHi = p.ci_hi > 0 ? x(pct(p, p.ci_hi)) : null;
          const lastLane = laneY(p.curve.length - 1);
          return (
            <g key={p.index_id}>
              {/* The print's own interval, behind the quotes it is quoted around. */}
              {ciLo != null && ciHi != null ? (
                <rect
                  x={Math.min(ciLo, ciHi)}
                  y={top + HEAD_H - 4}
                  width={Math.abs(ciHi - ciLo)}
                  height={lastLane - top - HEAD_H + 12}
                  fill="var(--sky)"
                  opacity={0.07}
                />
              ) : null}

              <text x={M.left} y={top + 12}>
                {p.index_id} · {serviceName(p.index_id).toUpperCase()}
                {Math.abs(skew) >= 0.5 ? (
                  <tspan fill="var(--ether-45)">
                    {" · "}
                    {plain ? "DEALER LEAN" : "SKEW"} {skew > 0 ? "+" : "−"}
                    {Math.abs(skew).toFixed(1)} BP
                  </tspan>
                ) : null}
              </text>

              {/* The shape of the curve: the mids, joined front to back. */}
              {p.curve.length > 1 ? (
                <polyline
                  points={p.curve.map((c, j) => `${x(pct(p, c.mid))},${laneY(j)}`).join(" ")}
                  fill="none"
                  stroke="var(--rate-mark)"
                  strokeOpacity={0.35}
                  strokeWidth={1}
                />
              ) : null}

              {p.curve.map((c, j) => {
                const o = laneOpacity(j, p.curve.length);
                const y = laneY(j);
                const xb = x(pct(p, c.bid));
                const xa = x(pct(p, c.ask));
                const xm = x(pct(p, c.mid));
                return (
                  <g key={c.tenor_weeks} opacity={o}>
                    {/* The tenor label lives in the left gutter, right-anchored,
                        exactly as the mark chart's y-labels do. */}
                    <text x={M.left - 8} y={y + 3.5} textAnchor="end">
                      {tenorLabel(c)}
                    </text>
                    <line
                      x1={xb}
                      y1={y}
                      x2={xa}
                      y2={y}
                      stroke="var(--sky)"
                      strokeOpacity={0.55}
                      strokeWidth={1}
                    />
                    <line x1={xb} y1={y - 4} x2={xb} y2={y + 4} stroke="var(--ink-70)" />
                    <line x1={xa} y1={y - 4} x2={xa} y2={y + 4} stroke="var(--ink-70)" />
                    <circle cx={xm} cy={y} r={5.5} fill="var(--rate-mark)" opacity={0.22} />
                    <circle cx={xm} cy={y} r={2.75} fill="var(--rate-mark)" />
                    {/* Only the front tenor prices itself in the plot; the rest
                        would collide at this lane height, and the sheet below
                        carries every figure to the basis point. */}
                    {j === 0 ? (
                      <>
                        <text x={xb} y={y - 7} textAnchor="middle">
                          {fmtPrice(c.bid)}
                        </text>
                        <text x={xa} y={y - 7} textAnchor="middle">
                          {fmtPrice(c.ask)}
                        </text>
                      </>
                    ) : null}
                    <text x={xa + 8} y={y + 3.5} fill="var(--ether-45)">
                      {fmtInt(c.spread_bp)} BP
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* the reading line — a vertical crosshair at the scrubbed price level */}
        {lineX != null ? (
          <line
            x1={lineX}
            y1={PAD_TOP - 14}
            x2={lineX}
            y2={H - PAD_BOTTOM}
            stroke="var(--rate-mark)"
            strokeOpacity={0.7}
            strokeWidth={1}
          />
        ) : null}
      </svg>
    </>
  );
}
