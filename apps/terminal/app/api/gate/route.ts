import { NextResponse } from "next/server";
import { fetchLiveMeta } from "@/lib/api";
import type { AgentGateInfo, ArmorInfo, GateData } from "@/lib/gate";
import type { Envelope } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* What guards agent-to-agent traffic here, read from the service rather than
 * stated from a constant.
 *
 * ONE ROUTE FOR TWO READS because they answer one question. "Is the gate real"
 * and "is the screen real" are the same doubt in two places, the footer renders
 * them together, and two proxy routes would mean two polls for one line of copy.
 * `/api/humanid` already sets this precedent: several upstream reads, each
 * independently allowed to fail, assembled into one envelope.
 *
 * THE RULE THIS ROUTE EXISTS TO ENFORCE, and it is the same one `/api/humanid`
 * carries: a screen that silently fell back to its offline floor and a screen that
 * is inspecting nothing look identical from outside. `/armor/info` reports which
 * backend actually answered, so the footer can say so instead of the README
 * claiming it. An unread service is `null`, never a confident "local".
 */

const TIMEOUT_MS = 9_000;

export async function GET() {
  const [agentRes, armorRes] = await Promise.all([
    fetchLiveMeta<AgentGateInfo>("/agent/info", TIMEOUT_MS),
    fetchLiveMeta<ArmorInfo>("/armor/info", TIMEOUT_MS),
  ]);

  const data: GateData = { agent: agentRes.data, armor: armorRes.data };

  // `live` means BOTH answered. A half-read gate badged as current is how a
  // footer ends up asserting a screen while the gate behind it is unreachable.
  const live = data.agent != null && data.armor != null;
  const env: Envelope<GateData> = {
    live,
    data,
    fetchedAt: Date.now(),
    upstream: live ? "ok" : (agentRes.upstream === "ok" ? armorRes.upstream : agentRes.upstream),
  };
  return NextResponse.json(env, {
    headers: {
      // Configuration, not market data. Cached harder than the tape, which turns
      // over every block; the counters move but nothing decides on them quickly.
      "Cache-Control": live ? "public, s-maxage=60, stale-while-revalidate=300" : "no-store",
    },
  });
}
