import type { Metadata } from "next";
import { loadTerminal } from "@/lib/api";
import { serverChain } from "@/lib/serverChain";
import { CurveView } from "./view";

export const metadata: Metadata = {
  title: "Term Structure · ACR",
  description: "The forward curve for machine commerce: weekly tenors on every ACR index.",
};

export const dynamic = "force-dynamic";

export default async function CurvePage() {
  const chain = await serverChain();
  const initial = await loadTerminal(chain);
  return <CurveView initial={initial} />;
}
