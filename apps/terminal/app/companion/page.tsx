import type { Metadata } from "next";
import Link from "next/link";
import { GLOSSARY_THEMES, PLAIN_GLOSSARY, PRIMER_BEATS } from "@/lib/plainGlossary";

export const metadata: Metadata = {
  title: "The Reader’s Companion — ACR",
  description:
    "Every term this paper uses, in one line each with an everyday analogy — the plain-English companion to the Arc Compute Rate.",
};

/* The Reader's Companion: the plain-language dictionary as an editorial page.
   Pure static content (no data fetch, no client state) — the one page whose
   voice is the same in both editions, because it IS the plain voice. Content
   is lib/plainGlossary.ts, distilled from docs/GLOSSARY.md (the CI-enforced
   canonical glossary). */
export default function CompanionPage() {
  return (
    <>
      <div className="standfirst-block" style={{ marginTop: 40 }}>
        <p className="standfirst" style={{ margin: 0 }}>
          Every term this paper uses, in one line each — with the everyday analogy that makes it
          stick. No prior knowledge assumed.
        </p>
      </div>

      <section className="section">
        <div className="section-head">
          <span className="label">The whole thing in five beats</span>
        </div>
        <div className="primer-rail">
          {PRIMER_BEATS.map((b) => (
            <div className="primer-beat" key={b.head}>
              <h3 className="primer-head">{b.head}</h3>
              <p className="primer-body">{b.body}</p>
            </div>
          ))}
        </div>
      </section>

      {GLOSSARY_THEMES.map((theme) => (
        <section className="section companion-theme" key={theme}>
          <div className="section-head">
            <span className="label">{theme}</span>
          </div>
          <div className="companion-grid">
            {Object.entries(PLAIN_GLOSSARY)
              .filter(([, t]) => t.theme === theme)
              .map(([key, t]) => (
                <div className="companion-entry" key={key}>
                  <b>{t.term}</b>
                  <p>{t.gloss}</p>
                </div>
              ))}
          </div>
        </section>
      ))}

      <section className="section">
        <p className="muted" style={{ fontSize: 13, maxWidth: 68 * 9 }}>
          This page is the live rendering of the project’s canonical plain-English glossary
          (<span className="mono">docs/GLOSSARY.md</span>, coverage-checked in CI). For the same
          treatment applied to the whole paper, flip the masthead to{" "}
          <b>plain</b> — every page re-sets its type, every number stays identical.
        </p>
        <p style={{ marginTop: 16 }}>
          <Link href="/" className="section-link">
            ← Back to the front page
          </Link>
        </p>
      </section>
    </>
  );
}
