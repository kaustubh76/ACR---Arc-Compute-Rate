import type { Metadata } from "next";
import { TapeView } from "./view";

export const metadata: Metadata = {
  title: "The tape · ACR",
  description:
    "Machine transaction-cost analysis: what an agent paid for compute, against the benchmark it could have seen at that moment.",
};

export const dynamic = "force-dynamic";

/* No server preload, deliberately — the same rule /ops follows.
   Every figure on this page is a MEASUREMENT of how well an agent traded, and a
   server-rendered one would be as old as the render while reading as current.
   The client hook owns it, and says plainly when the tape cannot be reached. */
export default function TapePage() {
  return <TapeView />;
}
