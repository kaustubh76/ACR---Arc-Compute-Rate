"use client";

/* The workload editor — the one new element an unengaged reader ever sees.
 *
 * Design rule this component exists to uphold: personalization must not add
 * blocks to the page. Closed, it is a single `.section-link`-styled button in
 * the fixing section-head's right slot. Open, it unfolds ONE row inside that
 * same head (flexBasis 100% wraps it under the label, above the cards) and
 * collapses again on done. The reader's figures then live inside the rate
 * cards and the masthead, not in a panel of their own.
 *
 * Everything is client-local: the profile is saved to localStorage by
 * lib/useWorkload's single writer and read by the cards, the chip and the
 * index pages. Nothing is sent anywhere, and the row says so.
 */

import { useState } from "react";
import { Ed } from "./Ed";
import { useWorkload, setWorkload } from "@/lib/useWorkload";
import { PRESETS, type Workload } from "@/lib/workload";

/** Free-text field → a workload quantity: parse, clamp junk and negatives to
 *  0. The blank field is 0 ("I don't buy this"), matching parseWorkload. */
function qty(raw: string): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const num = (n: number) => (n > 0 ? String(n) : "");

/** The closed-state summary: only the parts the reader actually buys. */
function workloadLabel(w: Workload): string {
  const parts: string[] = [];
  if (w.inf > 0) parts.push(`${w.inf}M tok`);
  if (w.gpu > 0) parts.push(`${w.gpu} GPU-h`);
  if (w.data > 0) parts.push(`${w.data} GB`);
  return parts.join(" · ");
}

export function WorkloadRow() {
  const w = useWorkload();
  const [open, setOpen] = useState(false);
  // Field state is strings so a reader can clear and retype; seeded from the
  // saved profile each time the editor opens, not kept live against it.
  const [inf, setInf] = useState("");
  const [gpu, setGpu] = useState("");
  const [data, setData] = useState("");

  const openEditor = () => {
    setInf(num(w?.inf ?? 0));
    setGpu(num(w?.gpu ?? 0));
    setData(num(w?.data ?? 0));
    setOpen(true);
  };

  const save = () => {
    const next: Workload = { inf: qty(inf), gpu: qty(gpu), data: qty(data) };
    // All-empty means "no profile", same rule as parseWorkload — a reader who
    // clears every field is clearing the feature, and the cards go back to
    // the same paper everyone else reads.
    setWorkload(next.inf > 0 || next.gpu > 0 || next.data > 0 ? next : null);
    setOpen(false);
  };

  const field = (
    label: React.ReactNode,
    value: string,
    set: (v: string) => void,
    aria: string,
  ) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="label">{label}</span>
      <input
        className="mono"
        value={value}
        onChange={(e) => set(e.target.value)}
        inputMode="decimal"
        placeholder="0"
        aria-label={aria}
        // Width and a tighter pad for an inline figure field; the border,
        // radius and colour now come from the house field vocabulary in
        // globals.css rather than being restated here.
        style={{ width: 72, padding: "6px 9px" }}
      />
    </span>
  );

  return (
    <>
      {/* The trigger lives where .section-link already lives: the head's right
          slot. A button, not an anchor — it changes state, not location. */}
      <button
        type="button"
        className="section-link"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openEditor())}
        style={{ background: "transparent", border: 0, cursor: "pointer", padding: 0 }}
      >
        {w ? (
          <>
            <Ed x="your workload" p="your usage" /> · {workloadLabel(w)} ·{" "}
            <Ed x="edit" p="change" />
          </>
        ) : (
          <Ed x="price your workload" p="what would this cost you?" />
        )}
      </button>

      {open ? (
        /* flexBasis 100% wraps this onto its own line inside the flex-wrap
           section-head: the editor appears under the label, above the cards,
           without adding a section to the page. */
        <div
          style={{
            flexBasis: "100%",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 14,
            paddingTop: 6,
          }}
        >
          {field(<Ed x="M tokens/mo" p="M words/mo" />, inf, setInf, "million tokens per month")}
          {field(<Ed x="GPU-h/mo" p="GPU hours/mo" />, gpu, setGpu, "GPU hours per month")}
          {field(<Ed x="GB/mo" p="GB/mo" />, data, setData, "gigabytes per month")}

          <span style={{ display: "inline-flex", gap: 8 }}>
            {PRESETS.map((pr) => (
              <button
                key={pr.name}
                type="button"
                className="mini-btn"
                onClick={() => {
                  setInf(num(pr.w.inf));
                  setGpu(num(pr.w.gpu));
                  setData(num(pr.w.data));
                }}
              >
                {pr.name}
              </button>
            ))}
          </span>

          <button type="button" className="mini-btn" onClick={save} style={{ color: "var(--gold)" }}>
            <Ed x="done" p="done" />
          </button>

          <span className="muted" style={{ fontSize: 11.5 }}>
            <Ed
              x="saved in your browser · sent nowhere"
              p="saved in your browser · sent nowhere"
            />
          </span>
        </div>
      ) : null}
    </>
  );
}
