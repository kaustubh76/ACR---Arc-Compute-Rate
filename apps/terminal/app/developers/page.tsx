import type { Metadata } from "next";
import { loadTerminal } from "@/lib/api";
import { DevelopersView } from "./view";

export const metadata: Metadata = {
  title: "Developers · ACR",
  description: "Machines pay a sub-cent nanopayment per query for the rate, over x402 on Arc.",
};

export const dynamic = "force-dynamic";

export default async function DevelopersPage() {
  const initial = await loadTerminal();
  return <DevelopersView initial={initial} />;
}
