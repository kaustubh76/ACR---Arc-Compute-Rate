import type { Metadata } from "next";
import { baseState, loadTerminal } from "@/lib/api";
import { serverChain } from "@/lib/serverChain";
import { DevelopersView } from "./view";

export const metadata: Metadata = {
  title: "Developers · ACR",
  description: "Machines pay a sub-cent nanopayment per query for the rate, over x402 on Arc.",
};

export const dynamic = "force-dynamic";

export default async function DevelopersPage() {
  const chain = await serverChain();
  const initial = await loadTerminal(chain);
  /* The host the page is ACTUALLY reading from, which is not always the one
     NEXT_PUBLIC_ACR_API names: `lib/api.ts` refuses a seller whose chain is not
     the build's, even when that seller is perfectly healthy, and climbs to the
     published host instead (`chainMismatch` in lib/apiBase.ts records why).

     Measured on the live deployment 2026-10-08: `/api/health` reported the
     configured seller REFUSED on chain identity and a different host active —
     while the copy-paste config two sections down was still handing visitors the
     refused one. A snippet naming a host the page itself will not call is worse
     than no snippet, because it looks checked.

     So the snippets name this, not `sellerBase()`. Server-only on purpose:
     `baseState()` reaches the 133 KB fallback bundle, which must never be pulled
     into the browser. (No literals here — lib/mainnetOnly.test.ts gates the
     shipping UI on exactly that, and it is right to.) */
  const activeApi = baseState(chain).active;
  return <DevelopersView initial={initial} activeApi={activeApi} />;
}
