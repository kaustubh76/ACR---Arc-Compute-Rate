import { useId } from "react";
import { extent, linear, linePath } from "./scale";
import { GlowPath } from "./GlowPath";

/* 24h sparkline under each hero rate block: gold glow line over a soft
   gradient area. Grows a point per refresh; renders a quiet placeholder
   until history has body. */
export function Sparkline({
  values,
  width = 260,
  height = 36,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  const gradId = useId();
  if (values.length < 2) {
    return (
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} aria-hidden>
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--rule)"
          strokeDasharray="2 4"
        />
      </svg>
    );
  }
  const x = linear([0, values.length - 1], [1, width - 1]);
  const y = linear(extent(values, 0.15), [height - 3, 4]);
  const xs = values.map((_, i) => x(i));
  const ys = values.map((v) => y(v));
  const line = linePath(xs, ys);
  const area = `${line} L ${xs[xs.length - 1]} ${height - 1} L ${xs[0]} ${height - 1} Z`;
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e9a13f" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#e9a13f" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <GlowPath d={line} stroke="var(--rate-mark)" width={1.25} glowWidth={4} />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r={2} fill="var(--rate-mark)" />
    </svg>
  );
}
