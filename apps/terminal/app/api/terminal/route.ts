import { NextResponse } from "next/server";
import { loadTerminal } from "@/lib/api";
import { envelopeHeaders, requestChain } from "@/lib/envelope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const chain = requestChain(req);
  const env = await loadTerminal(chain);
  return NextResponse.json(env, {
    // Matches the 5s server memo; the CDN absorbs the poll fan-out from many
    // viewers while stale-while-revalidate keeps responses instant — but only
    // for an answer. A cushion served from the edge is one lost race wearing
    // the front page for everyone; see `envelopeHeaders`.
    headers: envelopeHeaders("public, s-maxage=5, stale-while-revalidate=30", chain, env),
  });
}
