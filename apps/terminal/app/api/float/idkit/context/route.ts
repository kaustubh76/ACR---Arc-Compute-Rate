import { NextResponse } from "next/server";

import { apiBase } from "@/lib/api";
import { envelope, refusalHeaders, requestChain } from "@/lib/envelope";
import type { GuestContext } from "@/lib/float";
import { isAgentAddress } from "@/lib/float";

/* Mint one join request: sign it, tell the press which wallet it is for, and
   hand the widget the context it needs.

   THIS ROUTE HOLDS A SECRET, which makes it the second of its kind here after
   `humanid/prove`. The signing key proves to World that a uniqueness request
   came from us, so it is read from the environment, used, and never placed in
   a response, a log or a URL. There is no `console.*` in this file on purpose.

   THE SPLIT OF CAPABILITY IS THE POINT. The terminal holds the signing key and
   cannot move money; the press holds the registrar key and cannot mint a
   request. Neither half can issue a budget alone, and that is why the signing
   key lives here rather than in the service that owns the chain.

   THE RENAME HAPPENS ONCE, HERE. `signRequest` returns `{sig, createdAt,
   expiresAt}`; the widget's `rp_context` wants `{signature, created_at,
   expires_at}`. A widget handed the signer's own shape renders perfectly and
   then fails at World, which is the worst way for this to break because it
   looks like it works. `rpContextTest` pins the mapping.

   WHY IT BINDS BEFORE IT ANSWERS. Selfie Check carries no signal of its own,
   so the signed nonce is the only thing tying a human's proof to a particular
   wallet. If the press cannot record that pairing, the request must not be
   handed out at all -- a proof arriving for a nonce nobody claimed would have
   no wallet to pay. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIMEOUT_MS = 9_000;

/** Bounded charset and length, so nothing from the environment can turn into a
 *  smuggled header line or an oversized field. Shape only: World decides
 *  whether the values are right. */
const RP_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const APP_ID_RE = /^app_[A-Za-z0-9_-]{4,128}$/;
const ACTION_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/** How long a join request stays spendable. Shorter than the press's own nonce
 *  window so the widget expires first and the visitor sees a clear refusal
 *  rather than a request the server has already forgotten. */
const TTL_S = 240;

function stoodDown(reason: string, chain: ReturnType<typeof requestChain>) {
  const data: GuestContext = { status: "pending", reason };
  return NextResponse.json(envelope(data, { live: true, chain }), { headers: refusalHeaders() });
}

export async function POST(req: Request) {
  const chain = requestChain(req);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400, headers: refusalHeaders() });
  }
  const { agent } = body as { agent?: unknown };
  if (typeof agent !== "string" || !isAgentAddress(agent)) {
    return NextResponse.json(
      { error: "agent must be a 20-byte hex address" },
      { status: 422, headers: refusalHeaders() },
    );
  }

  const rpId = process.env.ACR_FLOAT_GUEST_RP_ID ?? "";
  const appId = process.env.ACR_IDKIT_APP_ID ?? "";
  const action = process.env.ACR_FLOAT_GUEST_ACTION ?? "acr-float-guest-budget-v1";
  const key = process.env.ACR_IDKIT_SIGNING_KEY ?? "";

  /* Named one at a time rather than as "not configured", because these come
     from three different places in the Developer Portal and an operator who
     is told which one is missing fixes it in one visit. */
  if (!RP_ID_RE.test(rpId)) return stoodDown("ACR_FLOAT_GUEST_RP_ID is unset or malformed", chain);
  /* The portal issues two ids that read alike, so a swap is the likely mistake
     and it is worth naming here instead of letting World answer
     `invalid_rp_id_format` at verify time, one layer away from the cause.
     Deliberately NOT a required `rp_` prefix: the package only shows
     `rp_xxxxx` as a placeholder, never as a rule, and rejecting a valid
     credential the night before a deadline costs more than this catches. */
  if (rpId.startsWith("app_")) {
    return stoodDown("ACR_FLOAT_GUEST_RP_ID holds the app id; the rp id is a separate value", chain);
  }
  if (!APP_ID_RE.test(appId)) return stoodDown("ACR_IDKIT_APP_ID is unset or is not an app_ id", chain);
  if (!ACTION_RE.test(action)) return stoodDown("ACR_FLOAT_GUEST_ACTION is malformed", chain);
  if (!KEY_RE.test(key)) return stoodDown("ACR_IDKIT_SIGNING_KEY is unset or is not a 32-byte key", chain);

  let signed: { sig: string; nonce: string; createdAt: number; expiresAt: number };
  try {
    const { signRequest } = await import("@worldcoin/idkit-core/signing");
    /* `action` is REQUIRED for a uniqueness proof, not optional: it is hashed
       to a field element and appended to the signed message, and World scopes
       uniqueness per action. Omitting it signs a session request instead. */
    signed = signRequest({ signingKeyHex: key, action, ttl: TTL_S });
  } catch {
    //: No detail, and no exception text: a signing failure is about the key.
    return stoodDown("this host could not sign a join request", chain);
  }

  /* The press must know the pairing before the widget opens. One fixed
     upstream path, with nothing from the caller in the URL. */
  try {
    const res = await fetch(`${apiBase(chain)}/float/guest/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      //: Rebuilt from validated fields. Only these two can ever reach the press.
      body: JSON.stringify({ nonce: signed.nonce, agent }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return stoodDown("the press refused this join request", chain);
    const bound = (await res.json()) as { status?: string; reason?: string };
    if (bound?.status !== "ok") {
      return stoodDown(bound?.reason || "the press is not running the join page", chain);
    }
  } catch {
    return stoodDown("the press did not answer, so no join request was issued", chain);
  }

  const data: GuestContext = {
    status: "ok",
    app_id: appId,
    action,
    rp_context: {
      rp_id: rpId,
      nonce: signed.nonce,
      //: The rename. camelCase in, snake_case out, `sig` becomes `signature`.
      created_at: signed.createdAt,
      expires_at: signed.expiresAt,
      signature: signed.sig,
    },
  };
  return NextResponse.json(envelope(data, { live: true, chain }), { headers: refusalHeaders() });
}
