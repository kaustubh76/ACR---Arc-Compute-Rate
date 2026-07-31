/* Glow stroke without SVG filters (cheap, crisp, reduced-motion-safe): the
   same path drawn twice — a wide low-alpha halo under the 1.5px line.
   `draw` opts the top stroke into a one-shot line-draw reveal on mount
   (pathLength-normalized dash, animated in CSS; disabled under
   prefers-reduced-motion). Off by default so existing charts are unchanged. */
export function GlowPath({
  d,
  stroke,
  width = 1.5,
  glowWidth = 5,
  glowOpacity = 0.2,
  draw = false,
}: {
  d: string;
  stroke: string;
  width?: number;
  glowWidth?: number;
  glowOpacity?: number;
  draw?: boolean;
}) {
  return (
    <>
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={glowWidth}
        opacity={glowOpacity}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={width}
        strokeLinejoin="round"
        strokeLinecap="round"
        className={draw ? "draw-line" : undefined}
        pathLength={draw ? 1 : undefined}
      />
    </>
  );
}
