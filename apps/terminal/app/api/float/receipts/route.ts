import { NextResponse } from "next/server";

import { envelope, refusalHeaders, requestChain } from "@/lib/envelope";
import { readTape } from "@/lib/floatOnchain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Every payment and every refusal the chain kept, over the window it can serve.

   NOT CACHED, ON EITHER CHAIN. The newest row is the point of the surface and
   a stored answer would hand the next visitor a tape that has since moved.

   NO CALLER STRING REACHES THE NODE. The handler takes no parameters: the
   address and the RPC come from this host's environment, and the window is
   computed from the chain's own head. The only thing it reads off the request
   is the chain, and all that decides is whether this host answers at all. */
export async function GET(req: Request) {
  const chain = requestChain(req);
  const data = await readTape(chain);
  return NextResponse.json(envelope(data, { live: data.status === "ok", chain }), {
    headers: refusalHeaders(),
  });
}
