/* The credential pages live on their own origin, apart from the Aomi widget.
 *
 * The drawer embeds `@aomi-labs/widget` from npm: the vendor's code plus about
 * 775 transitive wallet-SDK packages, running in the main origin, not in an
 * iframe. Same-origin code can read sessionStorage, and two things live there
 * that must never meet third-party code:
 *
 *   acr-ops-key       the operator console's bearer key (/ops, /spend)
 *   acr-reader-card   a business owner's agent card (/spend; pasted on /developers)
 *
 * So the pages that collect or use them are served from a different origin
 * (NEXT_PUBLIC_ACR_OPS_ORIGIN, e.g. https://ops.arccomputerate.in) where the
 * widget is never mounted (`app/layout.tsx`), and `proxy.ts` keeps every other
 * page off it. The browser's same-origin policy then keeps the vendor's code
 * away from the keys: storage, DOM and window handles are all per origin.
 *
 * This REPLACED an in-origin guard (no drawer on these paths, no widget in a tab
 * already holding a key, a full reload when entering one), which could only
 * ever be as strong as "the vendor's code has not run in this tab yet". Without
 * the variable (local dev, previews) everything is one origin and nothing here
 * separates the widget from the keys.
 */

/** The pages that collect or use a credential, and everything under them. */
export const CREDENTIAL_PATHS = ["/ops", "/spend", "/developers"] as const;

export function credentialPath(path: string): boolean {
  const p = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return CREDENTIAL_PATHS.some((x) => p === x || p.startsWith(`${x}/`));
}

/** The two origins (`NEXT_PUBLIC_ACR_OPS_ORIGIN`; null when unset). The main
 *  site is that host minus its first label unless `NEXT_PUBLIC_ACR_SITE_ORIGIN`
 *  says otherwise. NEXT_PUBLIC_ so that one build-time value drives `proxy.ts`,
 *  the layout and every link alike: a server-only copy beside a browser copy
 *  could disagree. */
export function hostSplit(): { ops: URL; site: URL } | null {
  try {
    const raw = process.env.NEXT_PUBLIC_ACR_OPS_ORIGIN?.trim();
    if (!raw) return null;
    const ops = new URL(raw);
    const site = new URL(process.env.NEXT_PUBLIC_ACR_SITE_ORIGIN?.trim() || raw);
    if (!process.env.NEXT_PUBLIC_ACR_SITE_ORIGIN?.trim()) site.hostname = ops.hostname.slice(ops.hostname.indexOf(".") + 1);
    return { ops, site };
  } catch {
    return null;
  }
}

/** Where a link to `path` should point: an absolute URL on the host that serves
 *  it. A relative link from the ops host would be prefetched as a fetch, and a
 *  fetch cannot follow proxy.ts's redirect to another origin. An absolute
 *  same-origin href is still a client-side navigation. */
export function hostHref(path: string): string {
  const split = hostSplit();
  if (!split) return path;
  return `${(credentialPath(path) ? split.ops : split.site).origin}${path}`;
}
