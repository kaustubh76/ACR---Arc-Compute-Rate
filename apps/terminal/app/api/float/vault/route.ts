import { NextResponse } from "next/server";

import { envelope, refusalHeaders, requestChain } from "@/lib/envelope";
import { readVaultState } from "@/lib/floatOnchain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* The treasury, read off its own chain by this server.

   NO SHARED CACHE DIRECTIVE, on either chain. These numbers move on payments,
   the keeper drives payments on a ten minute loop and the agents on a minute
   one, and a CDN entry would hand the next visitor a buffer that has since been
   spent. The de-duplication that matters happens a layer down, in
   `lib/floatOnchain.ts`'s 30s memo: one RPC round per window per instance
   rather than one per visitor, which is the saving worth having here.

   NO CALLER STRING REACHES THE RPC. There is nothing to aim: the vault address
   and the RPC come from this host's environment and the handler takes no
   parameters at all. The one thing it reads off the request is the chain, and
   the only thing the chain can do is decide whether this host answers.

   `live` IS THE STATE'S OWN STATUS, NOT WHETHER THE FETCH RETURNED. A vault on
   another chain answers promptly and truthfully with "not here", and marking
   that `live: true` would light the page's own freshness rung over a panel that
   is deliberately empty. */
export async function GET(req: Request) {
  const chain = requestChain(req);
  /* `?prints=1` is asked for rather than assumed. It was ten more PACED reads
     and about four more seconds when that cost was real; `readPrints` batches
     now, so it is three more rounds. The float index does ask for them: the
     runway panel is priced off them. A caller that only wants the treasury
     still pays nothing for prints it will not render. */
  const withPrints = new URL(req.url).searchParams.get("prints") === "1";
  const data = await readVaultState(chain, withPrints);
  return NextResponse.json(envelope(data, { live: data.status === "ok", chain }), {
    headers: refusalHeaders(),
  });
}
