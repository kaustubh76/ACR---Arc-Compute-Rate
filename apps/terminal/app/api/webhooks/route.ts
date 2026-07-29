import { NextResponse } from "next/server";
import { fetchLiveMeta } from "@/lib/api";
import type { Envelope, WebhookFeed } from "@/lib/types";

export const dynamic = "force-dynamic";

const OFFLINE: WebhookFeed = { events: [], received: 0, verify_available: false };

export async function GET() {
  const { data, upstream } = await fetchLiveMeta<WebhookFeed>("/webhooks/recent");
  const env: Envelope<WebhookFeed> = data
    ? { live: true, data, fetchedAt: Date.now(), upstream }
    : { live: false, data: OFFLINE, fetchedAt: Date.now(), upstream };
  return NextResponse.json(env, {
    headers: { "Cache-Control": "public, s-maxage=3, stale-while-revalidate=15" },
  });
}
