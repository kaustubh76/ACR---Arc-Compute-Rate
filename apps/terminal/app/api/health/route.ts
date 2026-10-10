import { NextResponse } from "next/server";
import { baseState, fetchLive } from "@/lib/api";
import { envelopeHeaders, requestChain } from "@/lib/envelope";
import type { HealthData } from "@/lib/types";

export const dynamic = "force-dynamic";

/* Proxy to FastAPI /health — the gate/chain/poster mode oracle. Offline the
   data is null and the UI honestly reads SIM · ARCHIVED. */
export async function GET(req: Request) {
  const chain = requestChain(req);
  const data = await fetchLive<HealthData>(chain, "/health");
  const env = {
      live: Boolean(data),
      data: data ?? null,
      fetchedAt: Date.now(), chain,
      /* WHICH seller answered. A stale ACR_API once pointed at a suspended
         service for two days and every route quietly served the archive; the
         only reason it survived that long is that nothing reported it. */
      seller: baseState(chain),
  };
  return NextResponse.json(env, {
    headers: envelopeHeaders("public, s-maxage=10, stale-while-revalidate=60", chain, env),
  });
}
