/* World ID's own issuers, and the one cross-check that decides whether a
 * request to them can succeed at all.
 *
 * WHY THE ISSUER IS A CLOSED MAP RATHER THAN A SETTING A CALLER NAMES. The
 * route that uses this fetches a URL on the server's behalf, so a
 * caller-supplied host would make it a proxy pointed at whatever an attacker
 * liked, including our own internal addresses. The repo already draws this line
 * for the tape's read proxy -- "the query text lives server-side and the caller
 * names an allowlisted operation" -- and this is the same line. The map IS the
 * boundary; keep it closed.
 *
 * WHY `unadvertised` MATTERS AND IS NOT COSMETIC. An `acr` named in an
 * ESSENTIAL claims entry is not a preference the provider may ignore: it is a
 * requirement it cannot meet, and OIDC gives it one way to say so --
 * `access_denied`, the same code a human refusing produces. So asking for a
 * class the issuer does not advertise produces a failure that reads as "the
 * person said no". Both World issuers advertise exactly `orb` and `orb-face`,
 * while the step-up guide also documents `selfie` and `selfie-face`; a
 * developer who follows the guide configures a class nobody serves and spends
 * an hour deciding which source to believe. Checking discovery first is the
 * cheap half of that lesson.
 */

export const WORLD_ISSUERS = {
  production: "https://auth.world.org",
  sandbox: "https://sandbox.auth.world.org",
} as const;

export type WorldEnv = keyof typeof WORLD_ISSUERS;

export const ORB = "https://world.org/oidc/acr/orb";
export const ORB_FACE = "https://world.org/oidc/acr/orb-face";

export type WorldDiscovery = {
  env: WorldEnv;
  issuer: string;
  /** What the document says about itself. A mismatch is the redirect hazard. */
  issuerMatches: boolean;
  advertised: string[];
  claimsParameterSupported: boolean;
  deviceEndpoint: string;
  tokenEndpoint: string;
  /** Round trip to World, in milliseconds, measured on this request. */
  elapsedMs: number;
};

/** Is this one of World's own hosts? The guard the allowlist exists to give. */
export function isWorldIssuer(url: string): boolean {
  return (Object.values(WORLD_ISSUERS) as readonly string[]).includes(url);
}

export function resolveIssuer(env: string | undefined | null): {
  env: WorldEnv;
  issuer: string;
} {
  //: Anything unrecognised falls to sandbox rather than throwing, because this
  //: is a display surface and a typo in config should not take a page down.
  //: It can never fall to an arbitrary host: the map has two entries.
  const key: WorldEnv = env === "production" ? "production" : "sandbox";
  return { env: key, issuer: WORLD_ISSUERS[key] };
}

/** Required classes the issuer does not advertise. Empty is the good answer. */
export function unadvertised(required: string[], advertised: string[]): string[] {
  //: An EMPTY advertised list means discovery could not be read, not that the
  //: issuer serves nothing. Reporting every required class as missing on a
  //: failed fetch would turn a network blip into a configuration alarm.
  if (advertised.length === 0) return [];
  return required.filter((r) => !advertised.includes(r));
}

/** `https://world.org/oidc/acr/orb-face` -> `orb-face`, for display only. */
export function shortAcr(uri: string): string {
  const tail = uri.split("/").pop() ?? uri;
  return tail || uri;
}

/** The class a spend approval must reach, and what of it the issuer is missing.
 *
 *  Here rather than in the route because a `route.ts` may only export handlers
 *  and segment config, and because the panel and the press must not drift about
 *  what "required" means. */
export const REQUIRED_FOR_SPEND = [ORB];

export function unadvertisedForSpend(advertised: string[]): string[] {
  return unadvertised(REQUIRED_FOR_SPEND, advertised);
}
