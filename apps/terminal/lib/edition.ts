/* The edition core — pure and DOM-free so node:test can import it.
   Two editions of the same paper: "expert" (every term of art) and "plain"
   (the same numbers, set in plain language). The chosen edition lives as a
   data attribute on <html>, written pre-paint by the boot script below and
   thereafter only by lib/useEdition.ts — CSS picks the visible copy, so the
   server HTML is identical in both editions and hydration never diverges. */

export type Edition = "expert" | "plain";

export const EDITION_KEY = "acr-edition"; // localStorage
export const EDITION_PARAM = "edition"; // ?edition=plain — shareable demo link
export const EDITION_ATTR = "data-edition"; // on <html>; absent = expert
export const EDITION_TURN_ATTR = "data-edition-turn"; // transient: re-setting-type settle

/** "plain" | "expert" → Edition; anything else → null. */
export function parseEdition(raw: unknown): Edition | null {
  return raw === "plain" || raw === "expert" ? raw : null;
}

/** URL param beats stored choice beats the expert default. */
export function resolveEdition(param: string | null, stored: string | null): Edition {
  return parseEdition(param) ?? parseEdition(stored) ?? "expert";
}

/* The pre-paint boot script, inlined as the first child of <body> so the
   attribute lands before any content paints (no flash of the wrong edition).
   Built from the same constants the store imports — script and store cannot
   drift. Every storage touch is try/catch-wrapped: Safari private mode throws
   on access, and the edition then simply degrades to per-visit memory. */
export function editionBootScript(): string {
  return (
    "(function(){try{" +
    `var p=new URLSearchParams(location.search).get(${JSON.stringify(EDITION_PARAM)});` +
    `var s=null;try{s=localStorage.getItem(${JSON.stringify(EDITION_KEY)})}catch(e){}` +
    'var e=(p==="plain"||p==="expert")?p:(s==="plain"?"plain":"expert");' +
    `if(p==="plain"||p==="expert"){try{localStorage.setItem(${JSON.stringify(EDITION_KEY)},e)}catch(e){}}` +
    `if(e==="plain")document.documentElement.setAttribute(${JSON.stringify(EDITION_ATTR)},"plain");` +
    "}catch(e){}})();"
  );
}
