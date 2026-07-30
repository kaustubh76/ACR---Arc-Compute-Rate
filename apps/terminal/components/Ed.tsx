/* The edition swap — the one primitive behind the Plain Edition.
   Renders BOTH copies; CSS shows exactly one, keyed off html[data-edition]
   (stamped pre-paint by lib/edition.ts's boot script). Server HTML is thus
   identical in both editions: no hydration branch, no flash, and the hidden
   copy is display:none — out of the accessibility tree and tab order.

   Rules of the house:
   - Words only. Numbers, <TickerNumber>, <Sparkline>, links with handlers and
     any stateful node stay OUTSIDE (dual-rendering would double-mount them);
     split the sentence around them instead.
   - <Term> footnotes belong in the plain (p) branch only.
   - className is forwarded to BOTH variants (e.g. "standfirst", "label"). */

type EdTag = "span" | "p" | "div" | "li";

export function Ed({
  x,
  p,
  as = "span",
  className,
  style,
}: {
  /** Expert copy — the paper's native register. */
  x: React.ReactNode;
  /** Plain copy — same meaning, no term of art unexplained. */
  p: React.ReactNode;
  as?: EdTag;
  className?: string;
  style?: React.CSSProperties;
}) {
  const T = as;
  const cls = className ? ` ${className}` : "";
  return (
    <>
      <T className={`ed ed-x${cls}`} style={style}>
        {x}
      </T>
      <T className={`ed ed-p${cls}`} style={style}>
        {p}
      </T>
    </>
  );
}
