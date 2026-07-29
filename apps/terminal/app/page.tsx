import { loadTerminal } from "@/lib/api";
import { FixingView } from "./view";

export const dynamic = "force-dynamic";

export default async function Page() {
  const initial = await loadTerminal();
  return <FixingView initial={initial} />;
}
