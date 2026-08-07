"use client";

import { fmt, fmtInt } from "@/lib/format";
import { linear, linePath } from "./scale";
import { GlowPath } from "./GlowPath";
import { useCrosshair } from "./useCrosshair";
import { Ed } from "@/components/Ed";
import type { SeriesPoint } from "@/lib/types";

/* The exercise chart: estimator error in bp, hour by hour. Naive VWAP
   (vermilion) explodes inside the attack window; ACR (gold) stays on the
   floor — that flat line is the product. Fixed 12-hour x-domain so a running
   attack draws in left to right. Linear y on purpose: the scale gap IS the
   story. */

const W = 760;
const H = 280;
const M = { top: 10, right: 12, bottom: 26, left: 56 };

export function AttackChart({
  series,
  hoursTotal = 12,
  faded = false,
}: {
  series: SeriesPoint[];
  hoursTotal?: number;
  faded?: boolean;
}) {
  const n = series.length;
  const x = linear([0, hoursTotal - 1], [M.left, W - M.right]);
  const maxErr = Math.max(10, ...series.map((s) => s.vwap_err_bp));
  const y = linear([0, maxErr * 1.08], [H - M.bottom, M.top]);

  const xs = series.map((s) => x(s.hour));
  const { idx, svgRef, onPointerMove, onPointerLeave, onKeyDown } = useCrosshair(
    n,
    xs[0] ?? M.left,
    xs[n - 1] ?? W - M.right,
  );
  const pick = idx != null ? series[idx] : n ? series[n - 1] : null;

  const atkHours = series.filter((s) => s.attack).map((s) => s.hour);
  const atkX0 = atkHours.length ? x(Math.min(...atkHours)) : null;
  const atkX1 = atkHours.length ? x(Math.max(...atkHours) + 1) : null;

  return (
    <div className={faded ? "stage-faded" : undefined}>
      <div className="reading" aria-live="polite">
        <span className="vermilion">
          <i className="key-swatch" />
          <Ed x="naive VWAP error" p="plain average’s error" />
        </span>
        <span className="gold">
          <i className="key-swatch" />
          <Ed x="ACR error" p="ACR’s error" />
        </span>
        {pick && (
          <span>
            H{String(pick.hour).padStart(2, "0")} · <Ed x="VWAP" p="avg" />{" "}
            {fmtInt(pick.vwap_err_bp)} bp · ACR {fmt(pick.acr_err_bp, 1)} bp
          </span>
        )}
      </div>
      <svg
        ref={svgRef}
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        tabIndex={0}
        role="img"
        aria-label="attack exercise: VWAP error vs ACR error by hour; arrow keys move the reading line"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
      >
        {atkX0 != null && atkX1 != null && (
          <>
            <rect
              x={atkX0}
              y={M.top}
              width={atkX1 - atkX0}
              height={H - M.top - M.bottom}
              fill="var(--rust)"
              opacity={0.3}
            />
            <line
              x1={atkX0}
              y1={M.top}
              x2={atkX0}
              y2={H - M.bottom}
              stroke="var(--adversary)"
              strokeOpacity={0.5}
            />
            <line
              x1={atkX1}
              y1={M.top}
              x2={atkX1}
              y2={H - M.bottom}
              stroke="var(--adversary)"
              strokeOpacity={0.5}
            />
            <text x={atkX0 + 6} y={M.top + 14} fill="var(--adversary)">
              ATTACK WINDOW
            </text>
          </>
        )}

        {/* hairline axes: baseline + max tick only */}
        <line
          x1={M.left}
          y1={H - M.bottom}
          x2={W - M.right}
          y2={H - M.bottom}
          stroke="var(--rule)"
        />
        <line x1={M.left} y1={M.top} x2={M.left} y2={H - M.bottom} stroke="var(--rule)" />
        <text x={M.left - 8} y={H - M.bottom + 4} textAnchor="end">
          0
        </text>
        <text x={M.left - 8} y={y(maxErr) + 4} textAnchor="end">
          {fmtInt(maxErr)}
        </text>
        <text x={M.left - 8} y={(y(maxErr) + H - M.bottom) / 2} textAnchor="end">
          bp
        </text>
        {[0, 4, 8, hoursTotal - 1].map((h) => (
          <text key={h} x={x(h)} y={H - 8} textAnchor="middle">
            H{h}
          </text>
        ))}

        {n > 1 && (
          <>
            <GlowPath d={linePath(xs, series.map((s) => y(s.vwap_err_bp)))} stroke="var(--adversary)" />
            <GlowPath d={linePath(xs, series.map((s) => y(s.acr_err_bp)))} stroke="var(--rate-mark)" />
          </>
        )}
        {n > 0 && (
          <>
            <circle cx={xs[n - 1]} cy={y(series[n - 1].vwap_err_bp)} r={2.5} fill="var(--adversary)" />
            <circle cx={xs[n - 1]} cy={y(series[n - 1].acr_err_bp)} r={2.5} fill="var(--rate-mark)" />
          </>
        )}

        {idx != null && pick && (
          <>
            <line
              x1={xs[idx]}
              y1={M.top}
              x2={xs[idx]}
              y2={H - M.bottom}
              stroke="var(--ink-45)"
              strokeWidth={0.75}
            />
            <circle cx={xs[idx]} cy={y(pick.vwap_err_bp)} r={3} fill="var(--adversary)" />
            <circle cx={xs[idx]} cy={y(pick.acr_err_bp)} r={3} fill="var(--rate-mark)" />
          </>
        )}
      </svg>
    </div>
  );
}
