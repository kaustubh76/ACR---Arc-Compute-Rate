"use client";

/* A glossed term — the dotted-underline word a beginner can tap.
   Renders a real <button> (Enter/Space native) that toggles a one-line
   footnote from lib/plainGlossary.ts. Escape closes; focus leaving the pair
   closes. Authored only inside plain (p=) branches of <Ed> and plain-only
   blocks — in the expert edition the whole branch is display:none, so these
   buttons are unreachable there and the component needs no edition awareness.
   Keys are typed: an off-dictionary k fails next build.
   Do not use inside .table-scroll cells — the footnote would clip. */

import { useEffect, useRef, useState } from "react";
import { PLAIN_GLOSSARY, type TermKey } from "@/lib/plainGlossary";

export function Term({ k, children }: { k: TermKey; children: React.ReactNode }) {
  const g = PLAIN_GLOSSARY[k];
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLSpanElement>(null);
  const id = `term-${k}`;

  /* Keep the footnote on screen. `.term-pop` is absolutely positioned inside
     `.term-wrap`, which is `display: inline` — so its containing block is the
     glossed WORD, and `left: 0` means the left edge of that word. A word
     two-thirds of the way across a 375px viewport therefore opened a panel of
     up to 78vw reaching well past the right edge, and since neither `html` nor
     `body` sets `overflow-x`, tapping a glossary word scrolled the whole page
     sideways.

     CSS cannot clamp this: the containing block is a text fragment, so there
     is nothing to position against. So measure once on open and hand the
     correction back as a custom property the stylesheet applies. Capped at the
     room actually available to the left, so a long footnote on a narrow screen
     is pulled to the gutter and never past the opposite edge.

     `useEffect`, not `useLayoutEffect`: the footnote animates in over
     `--dur-2`, so a correction on the next frame is invisible, and
     useLayoutEffect warns when this is server-rendered. The element is
     mutated through the ref rather than through state, because a setState
     here would be a sixteenth `react-hooks/set-state-in-effect` site.

     Known limit: resizing the viewport while it is open leaves the shift
     stale. It closes on blur and on Escape, so the window is small. */
  useEffect(() => {
    const el = pop.current;
    if (!open || !el) return;
    const GUTTER = 12;
    el.style.setProperty("--term-shift", "0px");
    const box = el.getBoundingClientRect();
    const over = box.right - (document.documentElement.clientWidth - GUTTER);
    if (over > 0) {
      const room = Math.max(0, box.left - GUTTER);
      el.style.setProperty("--term-shift", `-${Math.min(over, room)}px`);
    }
  }, [open]);

  return (
    <span className="term-wrap">
      <button
        type="button"
        className="term"
        aria-expanded={open}
        aria-controls={id}
        title={open ? undefined : g.gloss}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        onBlur={(e) => {
          const wrap = e.currentTarget.parentElement;
          if (wrap && !wrap.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        {children}
      </button>
      {open ? (
        <span className="term-pop" id={id} role="note" ref={pop}>
          <b>{g.term}</b>
          {g.gloss}
        </span>
      ) : null}
    </span>
  );
}
