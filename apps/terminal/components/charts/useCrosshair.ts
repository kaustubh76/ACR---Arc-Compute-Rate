"use client";

import { useCallback, useRef, useState } from "react";

/* The reading line: rAF-throttled pointer tracking that resolves to the
   nearest data index (O(1) arithmetic — points are evenly indexed). Values
   print into a fixed mono caption row above the chart, never a floating
   tooltip. */

export function useCrosshair(nPoints: number, x0: number, x1: number) {
  const [idx, setIdx] = useState<number | null>(null);
  const raf = useRef(0);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (nPoints < 2 || !svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const vb = svgRef.current.viewBox.baseVal;
      const px = ((e.clientX - rect.left) / rect.width) * vb.width;
      const t = (px - x0) / (x1 - x0);
      const i = Math.max(0, Math.min(nPoints - 1, Math.round(t * (nPoints - 1))));
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => setIdx(i));
    },
    [nPoints, x0, x1],
  );

  const onPointerLeave = useCallback(() => {
    cancelAnimationFrame(raf.current);
    setIdx(null);
  }, []);

  return { idx, svgRef, onPointerMove, onPointerLeave };
}
