"use client";

/* A glossed term — the dotted-underline word a beginner can tap.
   Renders a real <button> (Enter/Space native) that toggles a one-line
   footnote from lib/plainGlossary.ts. Escape closes; focus leaving the pair
   closes. Authored only inside plain (p=) branches of <Ed> and plain-only
   blocks — in the expert edition the whole branch is display:none, so these
   buttons are unreachable there and the component needs no edition awareness.
   Keys are typed: an off-dictionary k fails next build.
   Do not use inside .table-scroll cells — the footnote would clip. */

import { useState } from "react";
import { PLAIN_GLOSSARY, type TermKey } from "@/lib/plainGlossary";

export function Term({ k, children }: { k: TermKey; children: React.ReactNode }) {
  const g = PLAIN_GLOSSARY[k];
  const [open, setOpen] = useState(false);
  const id = `term-${k}`;

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
        <span className="term-pop" id={id} role="note">
          <b>{g.term}</b>
          {g.gloss}
        </span>
      ) : null}
    </span>
  );
}
