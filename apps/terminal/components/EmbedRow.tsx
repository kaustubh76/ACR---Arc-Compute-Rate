"use client";

/* Carry the rate: the second quiet entry in the fixing head, beside "price
 * your workload", and built to the same rule (WorkloadRow.tsx): closed, it is
 * one `.section-link` button; open, it unfolds ONE row under the label and
 * collapses on done. Nothing is added to the page for a reader who does not
 * press it.
 *
 * What the row hands over is a Markdown badge, an HTML card, or the curl that
 * reads the print, each built from the deployment the reader is looking at
 * (`window.location.origin`, read when the row opens, never a hardcoded host).
 * The preview beside the buttons is the real image from this deployment, so
 * what a reader pastes is what they just saw, age included.
 */

import { useState } from "react";
import { Ed } from "./Ed";
import { CHAINS } from "@/lib/chainChoice";
import { EMBED_KINDS, embedSnippets, previewUrl, type EmbedKind } from "@/lib/embed";
import { INDICES, type IndexId } from "@/lib/indices";
import { useChain } from "@/lib/useChain";

export function EmbedRow() {
  const chain = useChain();
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState("");
  const [index, setIndex] = useState<IndexId>("ACR-INF");
  const [kind, setKind] = useState<EmbedKind>("badge");
  const [copied, setCopied] = useState(false);

  // Read on open rather than in an effect: `window` does not exist during SSR
  // and the row renders nothing until a reader asks for it.
  const openRow = () => {
    setOrigin(window.location.origin);
    setOpen(true);
  };

  const code = embedSnippets(origin, index, CHAINS[chain].published)[kind];
  const preview = previewUrl(origin, index, kind);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  }

  return (
    <>
      <button
        type="button"
        className="section-link"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openRow())}
        style={{ background: "transparent", border: 0, cursor: "pointer", padding: 0 }}
      >
        <Ed x="embed this rate" p="put this rate on your page" />
      </button>

      {open ? (
        /* flexBasis 100% wraps this onto its own line inside the flex-wrap
           section-head; `order` keeps it below BOTH triggers whichever one
           opened, so the head never shows a button dangling under a row. */
        <div
          style={{
            flexBasis: "100%",
            order: 10,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 14,
            paddingTop: 6,
          }}
        >
          <span style={{ display: "inline-flex", gap: 6 }} role="group" aria-label="which index">
            {INDICES.map((i) => (
              <button
                key={i}
                type="button"
                className={`mini-btn${index === i ? " green" : ""}`}
                aria-pressed={index === i}
                onClick={() => setIndex(i)}
              >
                {i}
              </button>
            ))}
          </span>
          <span style={{ display: "inline-flex", gap: 6 }} role="group" aria-label="which form">
            {EMBED_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className={`mini-btn${kind === k ? " green" : ""}`}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
              >
                {k === "badge" ? (
                  <Ed x="badge" p="badge" />
                ) : k === "card" ? (
                  <Ed x="card" p="card" />
                ) : (
                  <Ed x="curl" p="the raw number" />
                )}
              </button>
            ))}
          </span>

          {preview ? (
            // The proof: the same image a reader is about to paste, from this
            // deployment, carrying the print's age. Keyed so a change of index
            // or form fetches afresh rather than showing the previous one.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={preview}
              src={preview}
              alt={`${index} as a ${kind}, live from this deployment`}
              style={{ height: kind === "badge" ? 20 : 80, width: "auto" }}
            />
          ) : null}

          <div className="specimen" style={{ flexBasis: "100%", marginTop: 0 }}>
            <button type="button" className="copy-btn" onClick={copy}>
              {copied ? <Ed x="copied" p="copied" /> : <Ed x="copy" p="copy" />}
            </button>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", paddingRight: 64 }}>
              {code}
            </pre>
          </div>

          <span className="muted" style={{ fontSize: 11.5 }}>
            <Ed
              x="live from this deployment · the image says how old the print is"
              p="live from this site · the picture says how old the number is"
            />
          </span>
          <button
            type="button"
            className="mini-btn"
            onClick={() => setOpen(false)}
            style={{ color: "var(--gold)" }}
          >
            <Ed x="done" p="done" />
          </button>
        </div>
      ) : null}
    </>
  );
}
