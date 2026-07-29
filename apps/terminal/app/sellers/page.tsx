import type { Metadata } from "next";
import { loadTerminal } from "@/lib/api";
import { SellersView } from "./view";

export const metadata: Metadata = {
  title: "Registry — ACR",
  description: "Seller reliability and EIP-712 attestations: attestation earns placement.",
};

export const dynamic = "force-dynamic";

export default async function SellersPage() {
  const initial = await loadTerminal();
  return <SellersView initial={initial} />;
}
