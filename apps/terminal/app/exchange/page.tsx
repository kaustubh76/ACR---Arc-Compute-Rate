import type { Metadata } from "next";
import { loadTerminal } from "@/lib/api";
import { ExchangeView } from "./view";

export const metadata: Metadata = {
  title: "Exchange · ACR",
  description:
    "The exchange floor of the compute index: machine-readable listings, x402 nanopayment settlement, and the public receipts tape.",
};

export const dynamic = "force-dynamic";

export default async function ExchangePage() {
  const initial = await loadTerminal();
  return <ExchangeView initial={initial} />;
}
