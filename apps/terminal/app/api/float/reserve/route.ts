import { NextResponse } from "next/server";

import { envelope, refusalHeaders, requestChain } from "@/lib/envelope";
import { readReserveFacts } from "@/lib/floatOnchain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* The reserve sleeve's fund, read off its own chain by this server.

   WHY A ROUTE AT ALL, for a panel describing something that is not live. The
   reserve ships as a null sleeve pending a Circle allowlist, and the panel has
   always said so in prose — alongside an address it asked a reader to take on
   trust. The fund's own facts are permissionless: its symbol, its decimals, its
   supply, whether there is code at the two addresses, and what this treasury
   holds of it. Reading them costs nothing and turns the section's one load
   bearing claim, that the fund is real and on this chain, into something a
   judge can check.

   WHAT IT DELIBERATELY DOES NOT ANSWER. Whether this treasury is allowlisted to
   call the Teller. `docs/TAMEION.md` records that the accessor is not under any
   of the three usual names, so the honest answer is that we cannot read it, and
   guessing at an ABI to produce a reassuring boolean would be worse than the
   silence.

   NO CACHE DIRECTIVE. These numbers move slowly, but the panel's whole job is
   to be checkable right now, and a CDN entry would hand the next visitor a
   supply from an hour ago under a live label. The de-duplication that matters
   is the client's own poll interval. */
export async function GET(req: Request) {
  const chain = requestChain(req);
  const data = await readReserveFacts(chain);
  return NextResponse.json(envelope(data, { live: data.status === "ok", chain }), {
    headers: refusalHeaders(),
  });
}
