"use client";

import { fmt, fmtInt, serviceName } from "@/lib/format";
import { linear } from "./scale";
import type { PrintRow } from "@/lib/types";

/* The maker's quote corridor: one interval per index — bid to ask as a share
   of spot, gold tick at the mid, dashed rule at spot itself. The A-S maker
   currently quotes a common corridor across tenors (mid pinned to spot, width
   set by realized vol), so the corridor is the honest visualization; the
   per-tenor sheet below keeps the granularity. */

const W = 760;
const ROW_H = 76;
const PAD_TOP = 34;
const PAD_BOTTOM = 10;
const M = { left: 16, right: 16 };

export function QuoteCorridor({
  prints,
  only,
}: {
  prints: Record<string, PrintRow>;
  only?: string;
}) {
  const rows = Object.values(prints).filter(
    (p) => p.curve?.length && p.value > 0 && (!only || p.index_id === only),
  );
  if (!rows.length) return <div className="awaiting">Awaiting quotes —</div>;

  const pct = (p: PrintRow, v: number) => (100 * v) / p.value;
  const lo = Math.min(...rows.map((p) => pct(p, p.curve[0].bid)));
  const hi = Math.max(...rows.map((p) => pct(p, p.curve[0].ask)));
  const pad = (hi - lo) * 0.08 || 5;
  const x = linear([lo - pad, hi + pad], [M.left, W - M.right]);
  const H = PAD_TOP + rows.length * ROW_H + PAD_BOTTOM;

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`}>
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
        SPOT
      </text>

      {rows.map((p, i) => {
        const c = p.curve[0];
        const yMid = PAD_TOP + i * ROW_H + ROW_H / 2 + 6;
        const xb = x(pct(p, c.bid));
        const xa = x(pct(p, c.ask));
        const xm = x(pct(p, c.mid));
        return (
          <g key={p.index_id}>
            <text x={M.left} y={yMid - 22}>
              {p.index_id} · {serviceName(p.index_id).toUpperCase()} · SPREAD{" "}
              {fmtInt(c.spread_bp)} BP
            </text>
            <line x1={xb} y1={yMid} x2={xa} y2={yMid} stroke="var(--sky)" strokeOpacity={0.55} strokeWidth={1} />
            <line x1={xb} y1={yMid - 5} x2={xb} y2={yMid + 5} stroke="var(--ink-70)" />
            <line x1={xa} y1={yMid - 5} x2={xa} y2={yMid + 5} stroke="var(--ink-70)" />
            <circle cx={xm} cy={yMid} r={7} fill="var(--rate-mark)" opacity={0.22} />
            <circle cx={xm} cy={yMid} r={3.25} fill="var(--rate-mark)" />
            <text x={xb} y={yMid + 20} textAnchor="middle">
              {fmt(c.bid)}
            </text>
            <text x={xa} y={yMid + 20} textAnchor="middle">
              {fmt(c.ask)}
            </text>
            <text x={xm} y={yMid - 10} textAnchor="middle" fill="var(--rate)">
              {fmt(c.mid)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
