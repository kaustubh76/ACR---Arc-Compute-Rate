import { NextRequest, NextResponse } from "next/server";

import { envelope, refusalHeaders, requestChain } from "@/lib/envelope";
import { classifyQuote } from "@/lib/floatOnchain";
import { dryRunParams } from "@/lib/routeInput";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* "Would this be refused, and why" — answered by the vault, not by us.

   THE CONTRACT BUILT THIS DOOR. `FloatVault.classify` is a `view` whose own
   comment says it is there so "a caller can ask 'would this be refused, and
   why' without a transaction and get the chain's real answer". This route is
   that call and nothing more: it validates what it can encode, asks, and
   returns the vault's own sentence unreworded. No local re-implementation of
   the ladder, because a second copy of twelve ordered rungs is a second copy
   that disagrees under rounding, and the number a reader must be able to trust
   is the one the vault returned.

   IT SPENDS NOTHING AND SIGNS NOTHING. No key reaches this handler, the call is
   a `view`, and the nonce it carries is random and therefore unused — so the
   worst a hostile caller achieves is a free read of a public function they could
   make themselves. That is also why it is ungated: a refusal a visitor can
   reproduce for themselves is the entire demonstration.

   NEVER CACHED. The answer depends on the agent's spend today and on the
   store's current print id, both of which move, and a stored verdict would tell
   the next reader a payment is allowed after the cap that allowed it rolled. */
export async function GET(req: NextRequest) {
  const chain = requestChain(req);
  const parsed = dryRunParams(req.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 422, headers: refusalHeaders() });
  }
  const data = await classifyQuote(chain, parsed.req);
  return NextResponse.json(envelope(data, { live: data.status === "ok", chain }), {
    headers: refusalHeaders(),
  });
}
