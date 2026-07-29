"use client";

import { useCallback, useRef, useState } from "react";

/* The reading line: rAF-throttled pointer tracking that resolves to the
   nearest data index (O(1) arithmetic — points are evenly indexed). Values
   print into a fixed mono caption row above the chart, never a floating
   tooltip.

   Keyboard: the chart takes focus (tabIndex on the svg) and ←/→ step the
   pick, Home/End jump, Escape clears. Touch scrubbing works through pointer
   events (pair with `touch-action: none` on .chart). */

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

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>) => {
      if (nPoints < 2) return;
      const last = nPoints - 1;
      let next: number | null | undefined;
      switch (e.key) {
        case "ArrowLeft":
          next = Math.max(0, (idx ?? nPoints) - 1);
          break;
        case "ArrowRight":
          next = Math.min(last, (idx ?? -1) + 1);
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = last;
          break;
        case "Escape":
          next = null;
          break;
        default:
          return; // let every other key pass through
      }
      e.preventDefault();
      cancelAnimationFrame(raf.current);
      setIdx(next ?? null);
    },
    [nPoints, idx],
  );

  return { idx, svgRef, onPointerMove, onPointerLeave, onKeyDown };
}
