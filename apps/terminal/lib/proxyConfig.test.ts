import assert from "node:assert/strict";
import test from "node:test";

import { CHAIN_COOKIE } from "./chainChoice";

/* The float routes' chain default, exercised through the proxy itself.
 *
 * A SOURCE GREP WAS THE FIRST VERSION OF THIS AND IT WAS THE WRONG TEST. The
 * failure here is silent — a default that does not fire is indistinguishable
 * from no default, which is the empty page it exists to fix — so the only
 * assertion worth making is what the function actually returns for a request.
 *
 * `proxy.ts` is also where the credential host split lives, and
 * `lib/opsOrigin.test.ts` owns that half. Next supports one proxy per app, so
 * both jobs share the file: worth knowing before writing a second one, which
 * replaces rather than merges.
 */

async function hop(path: string, cookie?: string) {
  const { NextRequest } = await import("next/server");
  const u = new URL(`https://arccomputerate.in${path}`);
  const { proxy } = await import("../proxy");
  const res = proxy(new NextRequest(u, { headers: cookie ? { host: u.host, cookie } : { host: u.host } }));
  return {
    status: res.status,
    to: res.headers.get("location"),
    set: res.cookies.get(CHAIN_COOKIE)?.value ?? null,
  };
}

test("a first visit to a float route opens on the chain the treasury is on", async () => {
  for (const p of ["/float", "/float/join", "/float/approve", "/float/anything"]) {
    const r = await hop(p);
    assert.equal(r.set, "testnet", `${p} should default the chain`);
    /* A pass-through and not a redirect: with cookies blocked a redirect loops
       for ever, and this degrades to the page as it was. */
    assert.equal(r.to, null, `${p} must not redirect`);
  }
});

test("a reader's own choice survives, which is what makes this a default", async () => {
  /* The whole honesty of the thing. If this regresses, the default has become
     an override and is worse than the bug it fixed. */
  assert.equal((await hop("/float", `${CHAIN_COOKIE}=mainnet`)).set, null);
  assert.equal((await hop("/float", `${CHAIN_COOKIE}=testnet`)).set, null);
  /* Carrying other cookies is not carrying this one. */
  assert.equal((await hop("/float", "acr-edition=plain")).set, "testnet");
});

test("nothing outside the float routes is touched", async () => {
  for (const p of ["/", "/curve", "/tape", "/check", "/ops", "/api/float/vault"]) {
    assert.equal((await hop(p)).set, null, `${p} must keep the app's own default`);
  }
  /* A prefix is not a path. `/floating` is somebody else's page. */
  assert.equal((await hop("/floatx")).set, null);
  assert.equal((await hop("/floating")).set, null);
});
