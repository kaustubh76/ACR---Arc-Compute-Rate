import type { Metadata } from "next";
import { TractionView } from "./view";

export const metadata: Metadata = {
  title: "Traction · ACR",
  description:
    "How many businesses the agent runs for, what it moved, and what it caught — counted from the records.",
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

/* No loadTerminal(). These are the figures a reviewer checks, and a
   server-rendered count would be as old as the render. The client hook owns it,
   as on /ops and /spend. */
export default function TractionPage() {
  return <TractionView />;
}
