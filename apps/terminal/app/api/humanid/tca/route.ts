import { NextResponse } from "next/server";
import { apiBase } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Answer the challenge, and get one bill across a whole fleet.
 *
 * BACKEND-AGNOSTIC ON PURPOSE. Both verifiers read `HUMAN-PROOF` as base64 of a
 * JSON payload — AgentKit's signed CAIP-122 envelope and World ID's IDKit result
 * alike — so this route carries whichever the running gate expects and needs no
 * knowledge of which that is. There is no browser widget in front of it yet
 * (IDKit v4 needs an `rp_context` and a preset only the Developer Portal can
 * supply, and shipping a widget built against guessed config would be a button
 * that can only fail). It is exercisable today with curl, and it is the half
 * that does not change when a widget arrives.
 *
 * Two rules govern what happens in between, and both are about NOT being clever:
 *
 * 1. FORWARD THE PAYLOAD AS-IS. World's docs are explicit that the IDKit result
 *    needs no field remapping, and `WorldIdCloudVerifier` passes it straight to
 *    World's verifier. Renaming a field here would be re-deriving a contract we
 *    do not own, against a service that will simply reject it.
 * 2. NEVER LOG IT. A proof is a credential. The nullifier behind it is the
 *    durable identifier the whole rotation scheme exists to keep off our
 *    surfaces, so it does not belong in a server log either.
 *
 * What comes back carries no wallet list — `human_tca` reads the fleet from the
 * tape to answer the query and deliberately does not return it, because a
 * response that enumerated a fleet would hand it to anyone who later saw it.
 * This route adds nothing to that response.
 */

const TIMEOUT_MS = 20_000;

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = (await request.json())?.payload;
  } catch {
    return NextResponse.json({ available: false, reason: "malformed request" }, { status: 400 });
  }
  if (payload == null || typeof payload !== "object") {
    return NextResponse.json(
      { available: false, reason: "no proof payload" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const header = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/tca/human?days=7`, {
      cache: "no-store",
      headers: { "HUMAN-PROOF": header },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    // Deliberately not logging the payload, only that a call happened.
    console.warn(`[terminal] upstream ${timedOut ? "timeout" : "unreachable"} on /tca/human`);
    return NextResponse.json(
      { available: false, reason: "the press did not answer" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  const body = await res.json().catch(() => null);
  if (res.ok) {
    return NextResponse.json(body, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  /* The press's own refusal, passed through rather than re-worded. 401 is a
     rejected or replayed proof; 503 is a gate that is not configured, or a salt
     that does not match the mirror's commitment. Inventing our own phrasing here
     would make this surface disagree with the service it is reporting on. */
  const reason =
    (body && typeof body === "object" && "detail" in body && String(body.detail)) ||
    `the gate answered ${res.status}`;
  return NextResponse.json(
    { available: false, reason, status: res.status },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
