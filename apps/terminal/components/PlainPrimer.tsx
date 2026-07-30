/* "This paper in one minute" — the plain edition's five-beat opener on the
   front page. Always in the DOM, CSS-hidden in the expert edition (the
   .plain-only rules in globals.css), so hydration never branches. Pure
   component: the beats live in lib/plainGlossary.ts. */

import Link from "next/link";
import { PRIMER_BEATS } from "@/lib/plainGlossary";

export function PlainPrimer() {
  return (
    <section className="section primer plain-only">
      <div className="section-head">
        <span className="label">This paper in one minute</span>
        <span className="label muted">the same numbers, the whole story</span>
      </div>
      <div className="primer-rail">
        {PRIMER_BEATS.map((b) => (
          <div className="primer-beat" key={b.head}>
            <h3 className="primer-head">{b.head}</h3>
            <p className="primer-body">{b.body}</p>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
        Every term this paper still uses is explained in{" "}
        <Link href="/companion" className="section-link">
          the reader’s companion →
        </Link>
      </p>
    </section>
  );
}
