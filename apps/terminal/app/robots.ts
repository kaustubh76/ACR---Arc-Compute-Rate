import type { MetadataRoute } from "next";

/* Serves /robots.txt, which 404'd until now along with every other
 * conventional static file — see app/icon.svg for the same story.
 *
 * The rate is meant to be found: this is a public reference, and /companion
 * exists precisely so a first-time reader can arrive cold. What is excluded is
 * the machinery, not the argument.
 *
 * /api/ — eighteen JSON handlers, several of them state-changing (attack/start,
 * desk/[action], ops/actions). Nothing there is a page, so crawling it is pure
 * waste.
 *
 * /ops is deliberately NOT disallowed. The systems ledger stays publicly
 * readable on purpose — the whole claim of that page is that operators and
 * readers see the same numbers — but it should never be the result someone
 * lands on for "arc compute rate". That job belongs to a `noindex` in the
 * page's own metadata, and the two directives are doing different things: a
 * crawler blocked here could never fetch the page, so it could never read the
 * noindex either.
 *
 * No Sitemap: line. Nine routes do not need one, and pointing robots.txt at a
 * /sitemap.xml that does not exist would mint exactly the 404 this file is
 * part of removing.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/"],
    },
    host: "https://arc-compute-rate.vercel.app",
  };
}
