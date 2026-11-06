import { NextRequest, NextResponse } from "next/server";

import { envelope, refusalHeaders, requestChain } from "@/lib/envelope";
import { readWalk } from "@/lib/floatOnchain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TX = /^0x[0-9a-fA-F]{64}$/;

/* One payment, proven step by step from its own transaction.

   ON DEMAND, NEVER POLLED. A reader opens a row and this runs once: one
   `eth_getTransactionReceipt` carries every log in the transaction, so the
   payment, the sleeve pull and the receipt all decode from it. Nothing here
   is on a timer, which is why it can afford to be the slowest float route.

   THE HASH IS VALIDATED BEFORE IT REACHES THE NODE. It is the only caller
   string on any float route that reaches the chain at all, so it is checked
   against the exact shape of a transaction hash rather than merely trimmed.

   NOT CACHED. One fixed transaction's logs cannot change, but a refusal can
   (a hash not yet mined becomes one that is), and a shared cache on a
   non-default chain is downgraded anyway. */
export async function GET(req: NextRequest) {
  const chain = requestChain(req);
  const tx = (req.nextUrl.searchParams.get("tx") ?? "").trim();
  if (!TX.test(tx)) {
    return NextResponse.json({ error: "tx must be a 32 byte transaction hash" }, {
      status: 422,
      headers: refusalHeaders(),
    });
  }
  const data = await readWalk(chain, tx);
  return NextResponse.json(envelope(data, { live: data.status === "ok", chain }), {
    headers: refusalHeaders(),
  });
}
