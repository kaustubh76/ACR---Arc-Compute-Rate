import type { Metadata } from "next";
import { FloatApproveView } from "./view";

export const metadata: Metadata = {
  title: "Waiting on a human · ACR Float",
  description: "Payments parked on chain until a verified person approves them.",
  // Crawlable but not indexable, like /ops and /spend. The page is public on
  // purpose — the codes it shows cannot release money without the enrolled
  // human's own fresh proof — but it should never be a search result.
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

/* No server payload. The whole claim of this page is "here is what is waiting
   on you RIGHT NOW", and a server-rendered queue would be as old as the
   render. The client hook owns it, as on /ops. */
export default function FloatApprovePage() {
  return <FloatApproveView />;
}
