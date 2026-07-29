import { NextResponse } from "next/server";
import { fetchLive } from "@/lib/api";
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

export async function GET() {
  const data = await fetchLive<AttackStatus>("/demo/attack/status", 5000);
  const env: Envelope<AttackStatus> = data
    ? { live: true, data, fetchedAt: Date.now() }
    : { live: false, data: OFFLINE, fetchedAt: Date.now() };
  return NextResponse.json(env);
}
