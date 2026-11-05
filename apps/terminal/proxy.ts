import { NextResponse, type NextRequest } from "next/server";

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
 */
export function proxy(req: NextRequest) {
  const split = hostSplit();
  if (!split) return NextResponse.next();
  const url = req.nextUrl;
  const onOps = (req.headers.get("host") ?? url.host).toLowerCase() === split.ops.host;
  const shared = url.pathname.startsWith("/api/") || url.pathname.startsWith("/og/");
  if (shared || credentialPath(url.pathname) === onOps) return NextResponse.next();
  return NextResponse.redirect(new URL(`${url.pathname}${url.search}`, onOps ? split.site : split.ops), 307);
}

export const config = {
  // Everything but the build's static files and anything with an extension
  // (favicon.ico, icon.svg, robots.txt …), which both hosts serve alike.
  matcher: ["/((?!_next/static|_next/image|.*\\.[a-z0-9]+$).*)"],
};
