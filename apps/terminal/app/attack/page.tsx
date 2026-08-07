import type { Metadata } from "next";
import { ThemeRoom } from "@/components/ThemeRoom";
import { loadTerminal } from "@/lib/api";
import { AttackView } from "./view";

export const metadata: Metadata = {
  title: "Attack Lab · ACR",
  description: "Try to move the number: here's the bill. A live wash-flow attack on the index.",
};

export const dynamic = "force-dynamic";

export default async function AttackPage() {
  const initial = await loadTerminal();
  return (
    <>
      <ThemeRoom />
      <AttackView initial={initial} />
    </>
  );
}
