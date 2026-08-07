import type { Metadata } from "next";
import { OpsView } from "./view";

export const metadata: Metadata = {
  title: "Systems ledger · ACR",
  description: "Every pillar's standing, as the press itself reports it.",
};

export const dynamic = "force-dynamic";

/* No loadTerminal() here. Every other page opens with the server payload so
   the first paint carries real numbers; this one must not, because the whole
   claim of the page is "here is what is true RIGHT NOW" and a server-rendered
   ledger would be as old as the render. The client hook owns it. */
export default function OpsPage() {
  return <OpsView />;
}
