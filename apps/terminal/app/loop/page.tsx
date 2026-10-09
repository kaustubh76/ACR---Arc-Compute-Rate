import type { Metadata } from "next";
import { ThemeRoom } from "@/components/ThemeRoom";
import { loadTerminal } from "@/lib/api";
import { serverChain } from "@/lib/serverChain";
import { LoopView } from "./view";

export const metadata: Metadata = {
  title: "The Loop · ACR",
  description:
    "Drive the machine loop: a payment, its mirror, its benchmark, the bill, the decision, the next payment. Screen a message through Google Cloud Model Armor. Prove a person, not a wallet.",
};

export const dynamic = "force-dynamic";

export default async function LoopPage() {
  const chain = await serverChain();
  const initial = await loadTerminal(chain);
  return (
    <>
      <ThemeRoom />
      <LoopView initial={initial} />
    </>
  );
}
