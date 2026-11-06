/* The issuer allowlist and the assurance cross-check.
 *
 * The allowlist is an SSRF boundary, so it gets a property test rather than a
 * spot check: anything that ever lands in that map must be a World host. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ORB,
  ORB_FACE,
  WORLD_ISSUERS,
  isWorldIssuer,
  resolveIssuer,
  shortAcr,
  unadvertised,
} from "./worldIssuer";

test("every issuer in the allowlist is a World host, https, with no path", () => {
  //: This map is what stops the discovery route becoming a proxy aimed at
  //: anything a caller names, so it is checked as a property of the map and
  //: not of one entry.
  for (const url of Object.values(WORLD_ISSUERS)) {
    const u = new URL(url);
    assert.equal(u.protocol, "https:", `${url} must be https`);
    assert.ok(u.hostname.endsWith(".world.org"), `${url} must be a world.org host`);
    assert.equal(u.pathname, "/", `${url} must carry no path`);
    assert.ok(isWorldIssuer(url));
  }
});

test("a host that is not World's is not a World issuer", () => {
  for (const bad of [
    "https://auth.world.org.evil.test",
    "http://auth.world.org",
    "https://auth.world.org/redirect",
    "https://127.0.0.1",
    "",
  ]) {
    assert.equal(isWorldIssuer(bad), false, `${bad} must not pass`);
  }
});

test("an unrecognised env falls to sandbox, never to an arbitrary host", () => {
  for (const env of [undefined, null, "", "staging", "https://evil.test"]) {
    const { env: key, issuer } = resolveIssuer(env);
    assert.equal(key, "sandbox");
    assert.ok(isWorldIssuer(issuer));
  }
  assert.equal(resolveIssuer("production").issuer, WORLD_ISSUERS.production);
});

test("nothing is unadvertised when the issuer serves what we require", () => {
  assert.deepEqual(unadvertised([ORB], [ORB, ORB_FACE]), []);
  assert.deepEqual(unadvertised([ORB, ORB_FACE], [ORB, ORB_FACE]), []);
});

test("the step-up guide's selfie classes are NOT advertised by either issuer", () => {
  //: The documented trap, as a test. The guide describes these; discovery on
  //: both production and sandbox lists only orb and orb-face. Asking for one as
  //: an ESSENTIAL claim is refused as access_denied, which is the same code a
  //: human refusing produces, so the failure reads as a person saying no.
  const SELFIE = "https://world.org/oidc/acr/selfie";
  assert.deepEqual(unadvertised([SELFIE], [ORB, ORB_FACE]), [SELFIE]);
  assert.deepEqual(unadvertised([ORB, SELFIE], [ORB, ORB_FACE]), [SELFIE]);
});

test("an unreadable discovery is not 'everything is unadvertised'", () => {
  //: A network failure and a class the issuer does not serve are different
  //: facts. Collapsing them would turn a blip into a configuration alarm, and
  //: would do it in the alarming direction.
  assert.deepEqual(unadvertised([ORB, ORB_FACE], []), []);
});

test("shortAcr trims the URI to the name a person reads", () => {
  assert.equal(shortAcr(ORB), "orb");
  assert.equal(shortAcr(ORB_FACE), "orb-face");
  assert.equal(shortAcr("orb"), "orb");
});
