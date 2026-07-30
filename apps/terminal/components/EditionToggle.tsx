"use client";

/* The one-click button of the Plain Edition: a fixed-geometry segmented
   expert | plain control in the masthead. The highlight is driven purely by
   the html[data-edition] attribute (see globals.css .edition-seg rules), so
   it is correct pre-hydration; aria-pressed corrects silently after. */

import { setEdition } from "@/lib/useEdition";
import { useEdition } from "@/lib/useEdition";

export function EditionToggle() {
  const edition = useEdition();
  return (
    <span className="segmented edition-seg" role="group" aria-label="edition">
      <button
        type="button"
        className="seg-word on-x"
        aria-pressed={edition === "expert"}
        title="the full paper — every term of art"
        onClick={() => setEdition("expert")}
      >
        expert
      </button>
      <button
        type="button"
        className="seg-word on-p"
        aria-pressed={edition === "plain"}
        title="the same paper set in plain language — every number identical"
        onClick={() => setEdition("plain")}
      >
        plain
      </button>
    </span>
  );
}
