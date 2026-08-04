"use client";

import { fmt, fmtInt } from "@/lib/format";
import { basisBp, formatQty, markSeries } from "@/lib/futuresBook";
import { useEdition } from "@/lib/useEdition";
import { extent, linear, linePath } from "./scale";
import { GlowPath } from "./GlowPath";
import { useCrosshair } from "./useCrosshair";
import { Ed } from "@/components/Ed";
import type { FuturesTradeRow } from "@/lib/types";

/* What the futures actually traded at, against the rate they settle on.
 *
 * A sibling of HistoryChart rather than a branch inside it: this needs per-fill
 * buy/sell marks, a dashed oracle reference and a block axis, and bolting three
 * conditionals onto the index page's primary chart buys no reuse.
 *
 * The x-axis is the fill ordinal, LABELLED WITH BLOCK NUMBERS — never
 * wall-clock. That is forced, not chosen: a print's `ts` is SIM-seconds
 * (lib/format.ts:1), and in the archived bundle every fill carries the same
 * `seen_at` (the snapshot stamp), so a time axis collapses the whole series
 * into one column offline. Block height is real, monotone and verifiable.
 *
 * The dashed sand line is the point of the chart. A cash-settled future is only
 * interesting relative to the number it settles against, so the gold fill line
 * wandering around the oracle line IS the argument, made in one picture.
 */

const W = 760;
const H = 300;
const M = { top: 10, right: 12, bottom: 26, left: 72 };

export function FuturesMarkChart({
  trades,
  seriesId,
  oracle,
  you,
}: {
  trades: FuturesTradeRow[];
  seriesId: number;
  /** The live on-chain print this series settles against; null when unread. */
  oracle: number | null;
  /** The reader's own account, so their own fills are ringed. */
  you?: string;
}) {
  // Every hook runs unconditionally. A fill can land between polls and cross
  // the 1- and 2-point boundaries, and an early return above a hook would
  // change the hook count and take the tree down — the same reason
  // HistoryChart:20 spells this out.
  const plain = useEdition() === "plain";
  const rows = markSeries(trades ?? [], seriesId);
  const n = rows.length;
  const x = linear([0, Math.max(1, n - 1)], [M.left, W - M.right]);
  const xs = rows.map((_, i) => x(i));
  const { idx, svgRef, onPointerMove, onPointerLeave, onKeyDown } = useCrosshair(
    n,
    xs[0] ?? M.left,
    xs[n - 1] ?? W - M.right,
  );

  if (n === 0) {
    return (
      <div className="awaiting">
        <Ed
          x="No fills on this series yet — the first one prints here."
          p="No trades on this round yet — the first one appears here."
        />
      </div>
    );
  }

  // The oracle joins the y-domain so the reference line is always in frame —
  // a chart that crops the thing it is being compared against says nothing.
  const marks = rows.map((r) => r.mark);
  const y = linear(extent([...marks, ...(oracle != null ? [oracle] : [])], 0.12), [
    H - M.bottom,
    M.top,
  ]);
  const pick = rows[idx ?? n - 1];
  const bp = oracle != null ? basisBp(pick.mark, oracle) : null;
  const mine = you?.toLowerCase();
  const [dLo, dHi] = y.domain;

  return (
    <div>
      <div className="reading" aria-live="polite">
        <span className="gold">
          <Ed x="— fills" p="— trades" />
        </span>
        {oracle != null ? (
          <span className="muted">
            <Ed x="▮ oracle" p="▮ official rate" />
          </span>
        ) : null}
        <span>
          {pick.side === "buy" ? "BUY" : "SELL"} {formatQty(pick.qty)} @ {fmt(pick.mark)}
          {bp != null ? ` · ${bp >= 0 ? "+" : ""}${bp.toFixed(1)} bp` : ""} · block{" "}
          {fmtInt(pick.block)}
        </span>
      </div>
      <svg
        ref={svgRef}
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        tabIndex={0}
        role="img"
        aria-label={
          plain
            ? "real trades against the official rate — arrow keys move the reading line"
            : "on-chain fills against the oracle mark — arrow keys move the reading line"
        }
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
      >
        <line x1={M.left} y1={H - M.bottom} x2={W - M.right} y2={H - M.bottom} stroke="var(--rule)" />
        <line x1={M.left} y1={M.top} x2={M.left} y2={H - M.bottom} stroke="var(--rule)" />
        <text x={M.left - 8} y={y(dLo) + 4} textAnchor="end">
          {fmt(dLo)}
        </text>
        <text x={M.left - 8} y={y(dHi) + 4} textAnchor="end">
          {fmt(dHi)}
        </text>
        <text x={xs[0]} y={H - 8} textAnchor="start">
          {fmtInt(rows[0].block)}
        </text>
        {n > 1 ? (
          <text x={xs[n - 1]} y={H - 8} textAnchor="end">
            {fmtInt(rows[n - 1].block)}
          </text>
        ) : null}

        {/* The rate every one of these fills cash-settles against. */}
        {oracle != null ? (
          <>
            <line
              x1={M.left}
              y1={y(oracle)}
              x2={W - M.right}
              y2={y(oracle)}
              stroke="var(--rate)"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
            <text x={W - M.right} y={y(oracle) - 6} textAnchor="end" className="gold">
              {fmt(oracle)}
            </text>
          </>
        ) : null}

        {/* One fill is still a picture: the dot against the oracle line says
            something true. Only the connecting line needs two points. */}
        {n > 1 ? <GlowPath d={linePath(xs, marks.map(y))} stroke="var(--rate-mark)" /> : null}

        {rows.map((r, i) => (
          <g key={r.tx}>
            {mine && r.taker.toLowerCase() === mine ? (
              <circle
                cx={xs[i]}
                cy={y(r.mark)}
                r={5}
                fill="none"
                stroke="var(--validator)"
                strokeWidth={1.25}
              />
            ) : null}
            {/* Radius carries size, so a 2.0 fill reads bigger than a 0.25 —
                the fractional sizes the tape used to round away to zero. */}
            <circle
              cx={xs[i]}
              cy={y(r.mark)}
              r={2 + Math.min(2, Math.abs(r.qty))}
              fill={r.side === "buy" ? "var(--settled)" : "var(--adversary)"}
            />
          </g>
        ))}

        {idx != null && n > 1 && (
          <line
            x1={xs[idx]}
            y1={M.top}
            x2={xs[idx]}
            y2={H - M.bottom}
            stroke="var(--ink-45)"
            strokeWidth={0.75}
          />
        )}
      </svg>
    </div>
  );
}
