"use client";

import { useEffect } from "react";
import { Ed } from "@/components/Ed";

/* Route-level fault line. Renders INSIDE the layout, so the masthead, chain
   strip, and colophon stay alive — one broken panel never whites the page.
   Editorial voice: a printing fault, not a stack trace. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the real error for operators; readers get the editorial note.
    console.error("[terminal] page fault:", error);
  }, [error]);

  return (
    <section className="section" style={{ maxWidth: 68 * 9 }}>
      <div className="section-head">
        <Ed x="Press stop" p="Something broke" className="label" />
      </div>
      <Ed
        as="p"
        className="standfirst"
        style={{ marginTop: 8 }}
        x="This page hit a fault while setting type."
        p="This page hit a snag while loading."
      />
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 14 }}
        x="The rest of the edition keeps printing — reset the page to re-run it against the live feed."
        p="The rest of the site is fine — reset this page to try again."
      />
      <div style={{ marginTop: 16 }}>
        <button className="btn" onClick={() => reset()}>
          Reset the page
        </button>
      </div>
      {error?.digest ? (
        <details style={{ marginTop: 20 }}>
          <summary className="label" style={{ cursor: "pointer" }}>
            fault reference
          </summary>
          <pre className="mono" style={{ fontSize: 12, marginTop: 8 }}>
            digest: {error.digest}
          </pre>
        </details>
      ) : null}
    </section>
  );
}
