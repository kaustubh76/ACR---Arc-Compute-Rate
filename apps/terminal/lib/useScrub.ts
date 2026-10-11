"use client";

import { useCallback, useRef, useState } from "react";
import { scrubIndex, stepScrub } from "./scrub";

/* The reading line for an HTML element: rAF-throttled pointer tracking to the
   nearest of `n` evenly spaced points, ←/→/Home/End/Esc when the element has
   focus, cleared on leave and on blur. The arithmetic is in `lib/scrub.ts`.
   Pair with `touch-action: pan-y` so a phone can still scroll past it. */

export function useScrub<T extends HTMLElement>(n: number) {
  const [idx, setIdx] = useState<number | null>(null);
  const raf = useRef(0);
  const elRef = useRef<T | null>(null);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<T>) => {
      if (!elRef.current) return;
      const r = elRef.current.getBoundingClientRect();
      const i = scrubIndex(e.clientX - r.left, r.width, n);
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => setIdx(i));
    },
    [n],
  );

  const clear = useCallback(() => {
    cancelAnimationFrame(raf.current);
    setIdx(null);
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<T>) => {
      const next = stepScrub(idx, e.key, n);
      if (next === undefined) return; // every other key passes through
      e.preventDefault();
      cancelAnimationFrame(raf.current);
      setIdx(next);
    },
    [idx, n],
  );

  // Destructure at the call site, as every `useCrosshair` consumer does: the
  // compiler lint reads a member access on an object that holds a ref as a
  // ref read during render, and flags it.
  return { idx, elRef, onPointerMove, onPointerLeave: clear, onBlur: clear, onKeyDown };
}
