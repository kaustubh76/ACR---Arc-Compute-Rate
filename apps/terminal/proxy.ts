import { NextResponse, type NextRequest } from "next/server";

import { CHAIN_COOKIE, CHAIN_MAX_AGE_S, type ChainKey } from "@/lib/chainChoice";
import { credentialPath, hostSplit } from "@/lib/opsOrigin";

/* The credential pages live on their own origin (docs/AOMI_DRAWER.md).
 *
 * The Aomi widget is npm code running in the main origin, and sessionStorage is
 * per origin. So with the split configured (`hostSplit()`), /ops, /spend and
 * /developers are served only from the ops host and every other page only from
 * the main one: an operator key or an agent card is then typed into an origin
 * the widget's code has never run in, and the browser's same-origin policy
 * keeps the two apart (lib/opsOrigin.ts). When the split is not configured
 * (local dev, previews) this file does nothing and the site is one origin.
 *
 * The ops host also answers every `/api/*` route and `/og/*` image: the
 * credential pages fetch their own proxies same-origin, and those routes hold
 * no credential of their own. Static assets never reach this function (the
 * matcher), so both hosts serve the same `_next` bundle.
 *
 * Links already name the serving host (`hostHref`), so this only catches the
 * rest: typed URLs, bookmarks, the docs. It cannot be the links' mechanism,
 * because a router prefetch is a fetch, and a fetch refuses to follow a
 * redirect to another origin.
 *
 * 307, as in next.config.mjs: a host split is a deployment choice that can be
 * taken back, and a permanent redirect would outlive it in every browser.
 *
 * ---------------------------------------------------------------------------
 *
 * SECOND JOB: the float routes open on the chain the treasury is on.
 *
 * Measured in a fresh browser profile with no cookie, on the deployed page,
 * thirty seconds after load: `data-chain` was `mainnet`, one section rendered,
 * its heading was NOT ON THIS CHAIN, and the only button on the page was
 * SWITCH TO THE NETWORK IT RUNS ON. The rail, the readout, the drain slider,
 * the money path, the tape and the reserve reads were all behind that click.
 *
 * `DEFAULT_CHAIN` is mainnet and the float vault is deployed to one other
 * chain, so this was true of EVERY first visit since the float surface shipped.
 * Nobody caught it because every probe any of us runs sets the cookie first,
 * which is a lesson about probes as much as about defaults.
 *
 * A DEFAULT, NOT AN OVERRIDE. It fires only when the reader has no `acr-chain`
 * cookie, so a reader who chose mainnet keeps mainnet here as everywhere else.
 * What a reader who has chosen nothing gets instead is the chain the treasury
 * is actually on, with the chain strip saying so: the same state the button
 * produces, without needing the click. Nothing is faked and no number changes.
 *
 * TWO WRITES, WHICH IS WHY THERE IS NO REDIRECT. The request's own `cookie`
 * header is augmented so THIS render's `serverChain()` sees it, and the
 * response carries a `Set-Cookie` so the browser keeps it. A redirect would
 * have been shorter and is rejected on purpose: with cookies blocked it loops
 * for ever, where this degrades to exactly the behaviour above.
 *
 * IT LIVES HERE RATHER THAN IN ITS OWN FILE because Next supports exactly one
 * proxy per app, and this is it. Writing a second one does not merge; it
 * replaces, which is a thing I did and the ops-origin test caught.
 */

/** The chain the float vault is deployed to. The same expression
 *  `lib/floatOnchain.ts`'s `floatChain()` uses, duplicated because that module
 *  is `server-only` and pulls in viem, and this file may be deployed to a CDN
 *  separately from the render. If the vault moves, both move. */
function floatChain(): ChainKey {
  return process.env.ACR_FLOAT_CHAIN === "mainnet" ? "mainnet" : "testnet";
}

/** `NextResponse.next()`, plus the float chain default when it applies.
 *
 *  Every `next()` in this file goes through here, so the default lands whether
 *  or not the host split is configured and on whichever host served the page. */
function passThrough(req: NextRequest): NextResponse {
  const onFloat = req.nextUrl.pathname === "/float" || req.nextUrl.pathname.startsWith("/float/");
  if (!onFloat || req.cookies.has(CHAIN_COOKIE)) return NextResponse.next();

  const chain = floatChain();
  /* Appended, not replaced: the reader may carry an edition cookie and anything
     else, and this request still needs all of it. */
  const headers = new Headers(req.headers);
  const had = headers.get("cookie");
  headers.set("cookie", had ? `${had}; ${CHAIN_COOKIE}=${chain}` : `${CHAIN_COOKIE}=${chain}`);

  const res = NextResponse.next({ request: { headers } });
  res.cookies.set({ name: CHAIN_COOKIE, value: chain, path: "/", maxAge: CHAIN_MAX_AGE_S, sameSite: "lax" });
  return res;
}
export function proxy(req: NextRequest) {
  const split = hostSplit();
  if (!split) return passThrough(req);
  const url = req.nextUrl;
  const onOps = (req.headers.get("host") ?? url.host).toLowerCase() === split.ops.host;
  const shared = url.pathname.startsWith("/api/") || url.pathname.startsWith("/og/");
  if (shared || credentialPath(url.pathname) === onOps) return passThrough(req);
  return NextResponse.redirect(new URL(`${url.pathname}${url.search}`, onOps ? split.site : split.ops), 307);
}

export const config = {
  // Everything but the build's static files and anything with an extension
  // (favicon.ico, icon.svg, robots.txt …), which both hosts serve alike.
  matcher: ["/((?!_next/static|_next/image|.*\\.[a-z0-9]+$).*)"],
};
