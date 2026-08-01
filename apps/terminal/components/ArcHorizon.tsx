"use client";

/* The signature fluid moment: Arc's dawn — deep-space navy rising into a
   gold horizon — as a live surface. Pure CSS/SVG, rendered as the colophon's
   footer band. Idle, light-waves radiate outward from the sun on a staggered
   9s loop while the sun itself breathes; everything stills under
   prefers-reduced-motion (CSS), leaving the static composition. */
export function ArcHorizon({ breathe = true }: { breathe?: boolean }) {
  const H = 96;
  const horizonY = H * 0.82;
  const cx = 600;
  const radii = [46, 70, 94];

  return (
    <div className={`arc-horizon${breathe ? " breathe" : ""}`} aria-hidden>
      <svg viewBox={`0 0 1200 ${H}`} preserveAspectRatio="xMidYMax slice">
        <defs>
          <radialGradient id="ah-sun" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#f5ecda" stopOpacity="0.9" />
            <stop offset="35%" stopColor="#e9a13f" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#e9a13f" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="ah-arc" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#acc6e9" stopOpacity="0" />
            <stop offset="50%" stopColor="#acc6e9" stopOpacity="0.55" />
            <stop offset="82%" stopColor="#e9a13f" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#e9a13f" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* the rising sun */}
        <circle className="sun" cx={cx} cy={horizonY} r={60} fill="url(#ah-sun)" />

        {/* concentric arcs of light, radiating out from the sun */}
        {radii.map((r, i) => (
          <g key={r} className="ring" style={{ ["--i" as string]: i }}>
            <path
              d={`M ${cx - r} ${horizonY} A ${r} ${r} 0 0 1 ${cx + r} ${horizonY}`}
              fill="none"
              stroke="url(#ah-arc)"
              strokeWidth={3.5}
              opacity={0.16}
            />
            <path
              d={`M ${cx - r} ${horizonY} A ${r} ${r} 0 0 1 ${cx + r} ${horizonY}`}
              fill="none"
              stroke="url(#ah-arc)"
              strokeWidth={1.25}
              opacity={0.8}
            />
          </g>
        ))}

        {/* the horizon line itself */}
        <line
          x1={0}
          y1={horizonY}
          x2={1200}
          y2={horizonY}
          stroke="#e9a13f"
          strokeOpacity={0.5}
          strokeWidth={1}
        />
      </svg>
    </div>
  );
}
