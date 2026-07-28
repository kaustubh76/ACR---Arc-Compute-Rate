/* Glow stroke without SVG filters (cheap, crisp, reduced-motion-safe): the
   same path drawn twice — a wide low-alpha halo under the 1.5px line. */
export function GlowPath({
  d,
  stroke,
  width = 1.5,
  glowWidth = 5,
  glowOpacity = 0.2,
}: {
  d: string;
  stroke: string;
  width?: number;
  glowWidth?: number;
  glowOpacity?: number;
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
      />
    </>
  );
}
