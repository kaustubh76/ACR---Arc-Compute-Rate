import { NextResponse } from "next/server";
import { apiBase } from "@/lib/api";
import type { HumanChallenge } from "@/lib/humans";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* The real 401, fetched live.
 *
 * Same move the API console already makes with the 402: show a reader the
 * challenge before anything is spent, so the gate is something they watched
 * happen rather than something we told them about. Nothing here is staged —
 * the nonce is minted by `humanid.py`'s `_Nonces` on the press, is single-use,
 * and expires.
 *
 * POST, not GET, because it is not a read: each call mints a nonce on the
 * server. A GET that quietly consumed server state would be the kind of thing
 * a prefetch could fire by accident.
 *
 * THE NONCE IS THE WHOLE POINT AND IS ALSO WHY THIS IS SAFE TO SHOW. It
 * authorizes nothing on its own: a caller still has to present a credential the
 * verifier accepts, and the nullifier behind that credential never leaves the
 * press. What a reader sees here is the shape of the demand, not a key.
 */

const TIMEOUT_MS = 9_000;

interface ChallengeResult {
  /** The press's own 401 body, or null when it did not challenge. */
  challenge: HumanChallenge | null;
  /** What actually happened, for the cases that are not a challenge. */
  status: number | null;
  /** Set when the press answered something other than a 401. */
  note: string | null;
}

export async function POST() {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/tca/human?days=7`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    console.warn(`[terminal] upstream ${timedOut ? "timeout" : "unreachable"} on /tca/human`);
    return NextResponse.json<ChallengeResult>(
      { challenge: null, status: null, note: "the press did not answer" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (res.status === 401) {
    const challenge = (await res.json()) as HumanChallenge;
    return NextResponse.json<ChallengeResult>(
      { challenge, status: 401, note: null },
      // Never cached: a nonce is single-use, so a cached challenge is a
      // challenge that cannot be answered.
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  /* A 200 here would mean the gate let an unauthenticated request through, and
     that is worth saying out loud rather than rendering as an empty panel. 503
     is the configured-but-broken case `prove()` raises on a salt that does not
     match the mirror's commitment. */
  const note =
    res.status === 200
      ? "the gate answered without asking for a proof"
      : res.status === 503
        ? "human proofs are not configured on this deployment"
        : `the press answered ${res.status}`;
  return NextResponse.json<ChallengeResult>(
    { challenge: null, status: res.status, note },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
