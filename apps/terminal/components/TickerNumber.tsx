"use client";

import { useEffect, useRef, useState } from "react";

/* Live numerals with zero layout shift: tabular mono + fixed decimal places.
   `roll` (hero variant) plays a per-digit vertical roll on changed characters;
   both variants flash a fading gold underline on update ("newswire update").
   prefers-reduced-motion disables both via CSS. */

function Digit({ ch }: { ch: string }) {
  return (
    <span className="digit">
      {/* remount on change so the roll-in animation replays for this digit only */}
      <span key={ch} className="digit-in">
        {ch}
      </span>
    </span>
  );
}

export function TickerNumber({
  text,
  roll = false,
  className = "",
}: {
  text: string;
  roll?: boolean;
  className?: string;
}) {
  const prev = useRef(text);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (prev.current !== text) {
      prev.current = text;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1300);
      return () => clearTimeout(t);
    }
  }, [text]);

  const cls = `tick${flash ? " tick-flash" : ""}${className ? ` ${className}` : ""}`;
  if (!roll) return <span className={cls}>{text}</span>;
  return (
    <span className={cls}>
      {text.split("").map((ch, i) => (
        <Digit key={i} ch={ch} />
      ))}
    </span>
  );
}
