import { NextResponse } from "next/server";

import { envelope, refusalHeaders, requestChain } from "@/lib/envelope";
import { readYield } from "@/lib/floatOnchain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* What the idle float earned, from the sleeve's own cash events.

   ITS OWN ROUTE, BECAUSE IT WALKS LOGS. The treasury read is two batched
   rounds; this one pages back to the sleeve's first deposit, which is the only
   way to recover a cost basis and is far slower. Folding it into the vault
   route would make every reader of the ladder wait for a number none of them
   asked for.

   NEVER CACHED. The live mark moves with the venue's share price and the basis
   moves on every rebalance; a stored answer would state a gain that has since
   changed. No caller string reaches the node: the sleeve comes off the vault
   and the span comes off the chain's own head. */
export async function GET(req: Request) {
  const chain = requestChain(req);
  const data = await readYield(chain);
  return NextResponse.json(envelope(data, { live: data.status === "ok", chain }), {
    headers: refusalHeaders(),
  });
}
