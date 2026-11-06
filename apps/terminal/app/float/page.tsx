import type { Metadata } from "next";
import { FloatView } from "./view";

export const metadata: Metadata = {
  title: "The agent holds no money · ACR Float",
  description: "A treasury that pays an agent's bills, refuses an overcharge in the chain's own words, and parks what the agent cannot authorise.",
  // Crawlable but not indexable, like the other two float surfaces. Everything
  // here is a read of a public chain, and none of it should be a search result.
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

/* No server payload. Every number on this page is a read of the float vault's
   own chain, and a server-rendered one would be as old as the render; the
   ladder in particular answers a question the visitor has not asked yet. The
   client hooks own it, as on /float/approve. */
export default function FloatPage() {
  return <FloatView />;
}
