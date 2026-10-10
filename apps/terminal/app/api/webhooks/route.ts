import { NextResponse } from "next/server";
import { fetchLiveMeta } from "@/lib/api";
import { envelopeHeaders, requestChain } from "@/lib/envelope";
import type { Envelope, WebhookFeed } from "@/lib/types";

export const dynamic = "force-dynamic";

const OFFLINE: WebhookFeed = { events: [], received: 0, verify_available: false };

export async function GET(req: Request) {
  const chain = requestChain(req);
  const { data, upstream } = await fetchLiveMeta<WebhookFeed>(chain, "/webhooks/recent");
  const env: Envelope<WebhookFeed> = data
    ? { live: true, data, fetchedAt: Date.now(), chain, upstream }
    : { live: false, data: OFFLINE, fetchedAt: Date.now(), chain, upstream };
  return NextResponse.json(env, {
    headers: envelopeHeaders("public, s-maxage=3, stale-while-revalidate=15", chain, env),
  });
}
