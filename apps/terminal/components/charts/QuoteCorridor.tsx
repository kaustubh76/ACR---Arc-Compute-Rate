"use client";

import { fmtInt, fmtPrice, serviceName } from "@/lib/format";
import { useEdition } from "@/lib/useEdition";
import { linear } from "./scale";
import { useCrosshair } from "./useCrosshair";
import type { PrintRow } from "@/lib/types";

/* The maker's quote corridor: one interval per index — bid to ask as a share
   of spot, gold tick at the mid, dashed rule at spot itself. The A-S maker
   quotes a common corridor across tenors (width set by realized vol), so the
   corridor is the honest visualization; the per-tenor sheet below keeps the
   granularity.

   The mid is NOT pinned to spot, whatever this comment used to claim. The
   reservation price leans on inventory — a short book quotes up, a long book
   down — so the gold dot sits deliberately off the dashed line, and the row
   header names that lean in bp so it cannot be mistaken for a drawing fault.

   A reading line (the same crosshair the other charts use) scrubs the price
   axis: the axis is continuous %-of-spot, so we sample it at RES steps and let
   `useCrosshair` resolve the cursor to a step — pointer OR ←/→/Home/End/Esc —
   then print the implied price per index into a fixed caption row above. */

const W = 760;
const ROW_H = 76;
const PAD_TOP = 34;
const PAD_BOTTOM = 10;
/* The SAME gutters HistoryChart and FuturesMarkChart use. Every chart here
   shares viewBox width 760 and renders at the same CSS width, so one user unit
   is one screen unit in all of them — which means a different `left` is a
   visible offset, not a detail. This was {left:16,right:16}: a 56-unit shift
   against the mark chart two sections below it on /curve, with the corridor's
   band 728 units wide against everything else's 676. */
const M = { left: 72, right: 12 };
const RES = 120; // price-axis sampling resolution for the reading line

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
  if (!rows.length) return <div className="awaiting">Awaiting quotes —</div>;

  const pct = (p: PrintRow, v: number) => (100 * v) / p.value;
  /** How far the maker's mid sits from spot, in bp. Positive = quoting above
   *  spot (a short book leaning the reservation price up). */
  const skewBp = (p: PrintRow, mid: number) => 10000 * (mid - p.value) / p.value;
  const lo = Math.min(...rows.map((p) => pct(p, p.curve[0].bid)));
  const hi = Math.max(...rows.map((p) => pct(p, p.curve[0].ask)));
  const pad = (hi - lo) * 0.08 || 5;
  const x = linear([lo - pad, hi + pad], [M.left, W - M.right]);
  const H = PAD_TOP + rows.length * ROW_H + PAD_BOTTOM;

  // Resolve the crosshair step → the %-of-spot the cursor sits on, and the
  // implied price that reads out per index (mid pinned to 100% = spot).
  const cursorPct = idx == null ? null : (lo - pad) + (idx / (RES - 1)) * (hi + pad - (lo - pad));
  const lineX = cursorPct == null ? null : x(cursorPct);
  const caption =
    cursorPct == null
      ? plain
        ? "hover or use ← → to read a price across the corridor"
        : "hover or ← → to read the corridor at any level"
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
        aria-label="Quote corridor — bid to ask as a share of spot, per index"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
      >
      {/* The left rule the other charts draw. Without it this chart had no
          visible edge to align to, so even at the right gutter the eye had
          nothing to line up against the mark chart below. */}
      <line
        x1={M.left}
        y1={PAD_TOP - 14}
        x2={M.left}
        y2={H - PAD_BOTTOM}
        stroke="var(--rule)"
      />

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
        const c = p.curve[0];
        const yMid = PAD_TOP + i * ROW_H + ROW_H / 2 + 6;
        const xb = x(pct(p, c.bid));
        const xa = x(pct(p, c.ask));
        const xm = x(pct(p, c.mid));
        return (
          <g key={p.index_id}>
            {/* Header and mid label used to sit 12px apart at an 11px font,
                with the header running horizontally under the marker. */}
            <text x={M.left} y={yMid - 28}>
              {p.index_id} · {serviceName(p.index_id).toUpperCase()} ·{" "}
              {plain ? "GAP" : "SPREAD"} {fmtInt(c.spread_bp)} BP
              {/* How far the maker's mid sits from spot, and why. The A-S
                  reservation price skews on inventory, so the gold dot is
                  DELIBERATELY off the dashed line — saying so turns a thing
                  that reads as a rendering fault into the signal it is. */}
              {Math.abs(skewBp(p, c.mid)) >= 0.5 ? (
                <tspan fill="var(--ether-45)">
                  {" · "}
                  {plain ? "DEALER LEAN" : "SKEW"} {skewBp(p, c.mid) > 0 ? "+" : "−"}
                  {Math.abs(skewBp(p, c.mid)).toFixed(1)} BP
                </tspan>
              ) : null}
            </text>
            <line x1={xb} y1={yMid} x2={xa} y2={yMid} stroke="var(--sky)" strokeOpacity={0.55} strokeWidth={1} />
            <line x1={xb} y1={yMid - 5} x2={xb} y2={yMid + 5} stroke="var(--ink-70)" />
            <line x1={xa} y1={yMid - 5} x2={xa} y2={yMid + 5} stroke="var(--ink-70)" />
            <circle cx={xm} cy={yMid} r={7} fill="var(--rate-mark)" opacity={0.22} />
            <circle cx={xm} cy={yMid} r={3.25} fill="var(--rate-mark)" />
            <text x={xb} y={yMid + 20} textAnchor="middle">
              {fmtPrice(c.bid)}
            </text>
            <text x={xa} y={yMid + 20} textAnchor="middle">
              {fmtPrice(c.ask)}
            </text>
            <text x={xm} y={yMid - 11} textAnchor="middle" fill="var(--rate)">
              {fmtPrice(c.mid)}
            </text>
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
