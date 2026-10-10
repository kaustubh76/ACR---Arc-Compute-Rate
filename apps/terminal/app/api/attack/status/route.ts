import { NextResponse } from "next/server";
import { fetchLive } from "@/lib/api";
import { requestChain } from "@/lib/envelope";
import type { AttackStatus, Envelope } from "@/lib/types";

export const dynamic = "force-dynamic";

const OFFLINE: AttackStatus = {
  state: "idle",
  params: null,
  hour: 0,
  hours_total: 12,
  series: [],
  usdc_burned: 0,
  n_adversarial: 0,
};

export async function GET(req: Request) {
  const chain = requestChain(req);
  const data = await fetchLive<AttackStatus>(chain, "/demo/attack/status", 5000);
  const env: Envelope<AttackStatus> = data
    ? { live: true, data, fetchedAt: Date.now(), chain }
    : { live: false, data: OFFLINE, fetchedAt: Date.now(), chain };
  return NextResponse.json(env);
}
