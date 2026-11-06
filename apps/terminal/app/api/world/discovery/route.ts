import { NextResponse } from "next/server";

import { envelope, refusalHeaders, requestChain } from "@/lib/envelope";
import type { WorldDiscovery } from "@/lib/worldIssuer";
import { resolveIssuer } from "@/lib/worldIssuer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* World's own discovery document, fetched live.

   WHY THIS EXISTS. Until now the terminal never called World at all: the IDKit
   route calls our press and the gate panel reads the chain, so the only
   World-track surface showed three Ethereum addresses and a reader had to take
   the integration on trust. This is a real round trip to World's
   infrastructure, and a visitor can open the same URL and compare.

   THE ISSUER IS NEVER TAKEN FROM THE REQUEST. It is resolved from server
   config through a two-entry allowlist, because a route that fetches a
   caller-named URL is a proxy pointed at whatever an attacker likes. Same line
   the tape's read proxy draws.

   NOTHING AUTHENTICATED HAPPENS HERE. Discovery is public; no client id and no
   secret touch this path, so the page can show it to anyone.

   WHAT IT PROVES, AND WHAT IT DOES NOT. That we talk to World, and what World
   advertises. Not that anybody approved anything -- that is a different claim
   with its own place on the page. */

const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 9_000;

type Cached = { at: number; value: WorldDiscovery };
let cached: Cached | null = null;

export async function GET(req: Request) {
  const chain = requestChain(req);
  const { env, issuer } = resolveIssuer(process.env.ACR_WORLD_OIDC_ENV);

  if (cached && cached.value.env === env && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json(
      envelope({ status: "ok", discovery: cached.value }, { live: true, chain }),
      { headers: refusalHeaders() },
    );
  }

  const started = Date.now();
  try {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(String(res.status));
    const doc = (await res.json()) as Record<string, unknown>;

    const advertised = Array.isArray(doc.acr_values_supported)
      ? (doc.acr_values_supported as unknown[]).map(String)
      : [];
    const value: WorldDiscovery = {
      env,
      issuer,
      /* The redirect hazard, surfaced. A document whose own `issuer` differs
         from the host we asked is the thing worldflow refuses outright before
         any token exists, so the page should be able to show it too. */
      issuerMatches: String(doc.issuer ?? "") === issuer,
      advertised,
      claimsParameterSupported: doc.claims_parameter_supported === true,
      deviceEndpoint: String(doc.device_authorization_endpoint ?? ""),
      tokenEndpoint: String(doc.token_endpoint ?? ""),
      elapsedMs: Date.now() - started,
    };
    cached = { at: Date.now(), value };
    return NextResponse.json(envelope({ status: "ok", discovery: value }, { live: true, chain }), {
      headers: refusalHeaders(),
    });
  } catch {
    /* DELIBERATELY NOT CACHED. A ten-minute memo on a failure would keep
       saying World is unreachable long after it came back, and this network
       has dropped DNS repeatedly. And it is reported as "did not answer",
       never as "advertises nothing": an unreadable document and an issuer that
       serves no classes are different facts, and only one of them is alarming. */
    return NextResponse.json(
      envelope(
        {
          status: "pending",
          reason: "World's issuer did not answer, so what it advertises cannot be shown",
          issuer,
        },
        { live: false, chain },
      ),
      { headers: refusalHeaders() },
    );
  }
}
