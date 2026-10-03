import type { Metadata } from "next";
import { SpendView } from "./view";

export const metadata: Metadata = {
  title: "Spend · ACR",
  description:
    "What the agent decided about one business's money, and what is waiting for its owner.",
  // Crawlable but not indexable, like /ops. The page is publicly readable on
  // purpose — a reviewer should be able to click into it without us in the
  // room — but it must never be the search result someone lands on for the
  // rate itself. app/robots.ts deliberately does not disallow it, because a
  // crawler blocked from fetching the page can never read this directive.
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

/* The one thing this page reads server-side. /traction lists every business
   and links into this page, so a business needs a URL — without one the link
   could only ever open whichever business happened to sort first, which is not
   the business the reader clicked.

   Validated against the same shape as the statement proxy's own guard: a
   registry slug or a 0x address. An unrecognised value is dropped rather than
   rejected, and the view falls through to its first row — a mistyped link
   showing the wrong business beats a 422 on a page that was working.

   In Next 16 `searchParams` is a Promise and must be awaited (see
   node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md).
   Awaited here rather than read through useSearchParams() in the view, which
   would need its own Suspense boundary to say the same thing. */
const BUSINESS = /^(0x[0-9a-fA-F]{40}|[a-z0-9][a-z0-9-]{0,40})$/;

/* No loadTerminal(). The whole claim of this page is "here is what the agent
   has decided and what is still waiting on you", and a server-rendered
   escalation queue would be as old as the render — it could show an approval
   that has already happened. The client hook owns it, exactly as on /ops. */
export default async function SpendPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string | string[] }>;
}) {
  const raw = (await searchParams).business;
  const want = Array.isArray(raw) ? raw[0] : raw;
  return <SpendView initial={want && BUSINESS.test(want) ? want : null} />;
}
