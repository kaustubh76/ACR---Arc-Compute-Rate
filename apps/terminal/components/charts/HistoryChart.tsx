"use client";

import { useId } from "react";
import { editionLabel, fmtPrice } from "@/lib/format";
import { useEdition } from "@/lib/useEdition";
import { bandPath, extent, linear, linePath } from "./scale";
import { GlowPath } from "./GlowPath";
import { useCrosshair } from "./useCrosshair";
import type { HistoryPoint } from "@/lib/types";

/* The primary chart of the index-detail page: recent prints (gold) inside
   their confidence ribbon (gold wash). Hover = the reading line; values print
   into the docked caption row, never a floating tooltip. */

const W = 760;
const H = 300;
const M = { top: 10, right: 12, bottom: 26, left: 72 };

export function HistoryChart({ history }: { history: HistoryPoint[] }) {
  // All hooks run unconditionally — history length can cross the 2-point
  // boundary between polls (a point lands every refresh), and an early return
  // above a hook would change the hook count and crash the tree.
  const ribbonId = useId();
  const plain = useEdition() === "plain";
  const n = history.length;
  const x = linear([0, Math.max(1, n - 1)], [M.left, W - M.right]);
  const xs = history.map((_, i) => x(i));
  const { idx, svgRef, onPointerMove, onPointerLeave, onKeyDown } = useCrosshair(
    n,
    xs[0] ?? M.left,
    xs[n - 1] ?? W - M.right,
  );

  if (n < 2) {
    return <div className="awaiting">Awaiting print history: a point lands every refresh.</div>;
  }

  const lo = history.map((h) => h.ci_lo);
  const hi = history.map((h) => h.ci_hi);
  const y = linear(extent([...lo, ...hi], 0.12), [H - M.bottom, M.top]);
  const pick = idx != null ? history[idx] : history[n - 1];
  const pickHalfBp = pick.value > 0 ? (1e4 * (pick.ci_hi - pick.ci_lo)) / pick.value / 2 : 0;

  const [dLo, dHi] = y.domain;

  return (
    <div>
      <div className="reading" aria-live="polite">
        <span className="gold">
          <i className="key-swatch" />
          print
        </span>
        <span className="muted">
          <i className="key-band" />
          95% CI
        </span>
        <span>
          {editionLabel(pick.ts)} · {fmtPrice(pick.value)} · ±{pickHalfBp.toFixed(1)} bp
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
            ? "rate history with its wiggle-room band; arrow keys move the reading line"
            : "print history with confidence ribbon; arrow keys move the reading line"
        }
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
      >
        <line x1={M.left} y1={H - M.bottom} x2={W - M.right} y2={H - M.bottom} stroke="var(--rule)" />
        <line x1={M.left} y1={M.top} x2={M.left} y2={H - M.bottom} stroke="var(--rule)" />
        {/* The value axis is a PRICE, so it needs price resolution: at
            ACR-DATA's level five fixed decimals left only three
            distinguishable gridline values across the whole domain. */}
        <text x={M.left - 8} y={y(dLo) + 4} textAnchor="end">
          {fmtPrice(dLo)}
        </text>
        <text x={M.left - 8} y={y(dHi) + 4} textAnchor="end">
          {fmtPrice(dHi)}
        </text>
        <text x={xs[0]} y={H - 8} textAnchor="start">
          {editionLabel(history[0].ts)}
        </text>
        <text x={xs[n - 1]} y={H - 8} textAnchor="end">
          {editionLabel(history[n - 1].ts)}
        </text>

        <defs>
          <linearGradient id={ribbonId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e9a13f" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#e9a13f" stopOpacity="0.04" />
          </linearGradient>
        </defs>
        <path d={bandPath(xs, hi.map(y), lo.map(y))} fill={`url(#${ribbonId})`} />
        <GlowPath d={linePath(xs, history.map((h) => y(h.value)))} stroke="var(--rate-mark)" />
        <circle cx={xs[n - 1]} cy={y(history[n - 1].value)} r={2.5} fill="var(--rate-mark)" />

        {idx != null && (
          <>
            <line
              x1={xs[idx]}
              y1={M.top}
              x2={xs[idx]}
              y2={H - M.bottom}
              stroke="var(--ink-45)"
              strokeWidth={0.75}
            />
            <circle cx={xs[idx]} cy={y(history[idx].value)} r={3} fill="var(--rate-mark)" />
          </>
        )}
      </svg>
    </div>
  );
}
