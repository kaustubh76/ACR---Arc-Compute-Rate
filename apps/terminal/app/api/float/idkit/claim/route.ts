import { NextResponse } from "next/server";

import { apiBase } from "@/lib/api";
import { envelope, refusalHeaders, requestChain } from "@/lib/envelope";
import type { GuestClaim, GuestReason } from "@/lib/float";

/* Spend a join request for one guest budget.

   TWO RULES, BOTH INHERITED FROM `humanid/tca` AND BOTH LOAD-BEARING.

   1. FORWARD THE PROOF AS-IS. World's docs are explicit that an IDKit result
      needs no field remapping, and the press passes it straight on to World's
      own verifier. Renaming a field here would be re-deriving a contract we do
      not own, against a service that will simply reject it. So `proof` is an
      opaque object and travels whole.

   2. NEVER LOG IT. A proof is a credential, and the nullifier behind it is the
      durable identifier the whole hashing scheme exists to keep off our
      surfaces, so it does not belong in a server log either. There is no
      `console.*` in this file, and the line below that reports an upstream
      failure deliberately records only THAT a call failed.

   The refusal shape is the join page's contract: a machine-readable `reason`
   from a fixed list, plus a human `detail`. A page has to branch on one and
   show the other, and a surface that can only say "verification failed" cannot
   tell a visitor whether to retry, install something, or stop. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIMEOUT_MS = 25_000;

/** The nonce is ours: we minted it in the context route, so it is held to the
 *  shape we mint rather than to whatever arrives. */
const NONCE_RE = /^(0x)?[0-9a-fA-F]{8,128}$/;

export async function POST(req: Request) {
  const chain = requestChain(req);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400, headers: refusalHeaders() });
  }
  const { nonce, proof } = body as { nonce?: unknown; proof?: unknown };
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
    return NextResponse.json({ error: "bad nonce" }, { status: 422, headers: refusalHeaders() });
  }
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    return NextResponse.json({ error: "proof must be an object" }, { status: 422, headers: refusalHeaders() });
  }

  try {
    const res = await fetch(`${apiBase(chain)}/float/guest/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      /* Rebuilt to exactly two fields, and `proof` is the one thing passed
         through untouched -- see rule 1. */
      body: JSON.stringify({ nonce, proof: proof as Record<string, unknown> }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer = (await res.json().catch(() => null)) as
      | { status?: string; claim?: GuestClaim["claim"]; detail?: { reason?: string; detail?: string } }
      | null;

    if (!res.ok) {
      /* The press's own reason and detail, passed through rather than reworded.
         A page branching on a reason we invented here would branch on fiction. */
      const reason = (answer?.detail?.reason ?? "verify_failed") as GuestReason;
      const detail = answer?.detail?.detail ?? "the proof was refused";
      return NextResponse.json(
        { error: detail, reason },
        { status: res.status, headers: refusalHeaders() },
      );
    }

    const data: GuestClaim =
      answer?.status === "ok" && answer.claim
        ? { status: "ok", claim: answer.claim }
        : { status: "pending", reason: "the press is not running the join page" };
    return NextResponse.json(envelope(data, { live: true, chain }), { headers: refusalHeaders() });
  } catch (e) {
    //: Deliberately not logging the body, only that a call did not complete.
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return NextResponse.json(
      {
        error: timedOut
          ? "the press did not answer in time; a proof is single use, so do not send this one again"
          : "the press is unreachable",
      },
      { status: 504, headers: refusalHeaders() },
    );
  }
}
