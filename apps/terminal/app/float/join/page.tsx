import type { Metadata } from "next";

import { FloatJoinView } from "./view";

export const metadata: Metadata = {
  title: "One budget, one human · ACR Float",
  description: "Prove once that you are a person, and a wallet you name gets a small daily allowance.",
  // Crawlable but not indexable, like /ops and /spend. The page is public on
  // purpose, but a search result pointing at a verification flow is how a
  // flow gets scraped rather than used.
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

/* No server payload, and nothing to prefetch. The whole page is a sequence of
   things a visitor does, and the one value it eventually shows comes from a
   chain write that has not happened yet at render time. */
export default function FloatJoinPage() {
  return <FloatJoinView />;
}
