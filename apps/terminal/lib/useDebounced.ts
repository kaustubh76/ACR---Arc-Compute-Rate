"use client";

import { useEffect, useState } from "react";

/* A value that lags the one you pass it, so a slider does not become a request
 * per pixel.
 *
 * WHY NOT `onPointerUp`. A range input is also a keyboard control: arrow keys
 * move it one step at a time and never fire a pointer event, so committing on
 * pointer release would leave every keyboard reader looking at a verdict for a
 * quote they are no longer on. Debouncing the VALUE treats both inputs the
 * same, which is the only version that is accessible.
 *
 * WHY NOT SWR's `dedupingInterval`. That collapses repeat reads of ONE key.
 * Dragging a slider produces a different key per step, so every step is a fresh
 * read as far as SWR is concerned, and 40 of them are 40 requests.
 */
/** @param value MUST keep a stable identity between renders when it has not
 *  changed. The timer is keyed on identity, so an object literal built inline
 *  at the call site re-arms it every render and, because settling causes a
 *  render that builds another literal, never reaches a steady state. Memoize
 *  an object before passing it; a primitive is always fine. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
