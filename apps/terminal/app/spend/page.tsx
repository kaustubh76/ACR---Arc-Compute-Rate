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

/* No loadTerminal(). The whole claim of this page is "here is what the agent
   has decided and what is still waiting on you", and a server-rendered
   escalation queue would be as old as the render — it could show an approval
   that has already happened. The client hook owns it, exactly as on /ops. */
export default function SpendPage() {
  return <SpendView />;
}
