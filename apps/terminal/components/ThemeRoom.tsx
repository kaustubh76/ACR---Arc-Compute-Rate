"use client";

import { useEffect } from "react";

/* The adversary room: /attack mounts this to shift the whole app from the
   cool navy dawn to the plum→clay heat field (data-room="adversary" swaps
   the gradient + glass/hairline temperature in globals.css). */
export function ThemeRoom({ room = "adversary" }: { room?: string }) {
  useEffect(() => {
    document.documentElement.setAttribute("data-room", room);
    return () => document.documentElement.removeAttribute("data-room");
  }, [room]);
  return null;
}
