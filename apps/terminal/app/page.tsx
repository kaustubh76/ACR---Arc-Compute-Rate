import { loadTerminal } from "@/lib/api";
import { serverChain } from "@/lib/serverChain";
import { FixingView } from "./view";

export const dynamic = "force-dynamic";

export default async function Page() {
  const chain = await serverChain();
  const initial = await loadTerminal(chain);
  return <FixingView initial={initial} />;
}
