/* The credential pages live on their own origin, apart from the Aomi widget (lib/opsOrigin.ts). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CREDENTIAL_PATHS, credentialPath, hostHref } from "./opsOrigin";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the credential pages, and nothing that merely resembles one", () => {
  for (const p of ["/ops", "/ops/", "/spend", "/spend?business=acr-fleet", "/developers", "/developers#mcp", "/ops/anything"]) {
    assert.equal(credentialPath(p), true, p);
  }
  for (const p of ["/", "/curve", "/check", "/tape", "/opsx", "/spender", "/developer"]) {
    assert.equal(credentialPath(p), false, p);
  }
});

test("every page that stores a credential is on the list", () => {
  // Read the source of truth rather than a second copy of the names.
  const ops = readFileSync(join(ROOT, "components/chain/OperatorConsole.tsx"), "utf8");
  const spend = readFileSync(join(ROOT, "components/spend/EscalationActions.tsx"), "utf8");
  const reader = readFileSync(join(ROOT, "lib/readerCard.ts"), "utf8");
  assert.match(ops, /KEY_STORE = "acr-ops-key"/);
  assert.match(spend, /KEY_STORE = "acr-ops-key"/);
  assert.match(reader, /"acr-reader-card"/);
  assert.deepEqual([...CREDENTIAL_PATHS].sort(), ["/developers", "/ops", "/spend"]);
});

/* proxy.ts routes by host. */
async function hop(url: string) {
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("../proxy");
  const u = new URL(url);
  const res = proxy(new NextRequest(u, {
    headers: { host: u.host },
  }));
  return { status: res.status, to: res.headers.get("location") };
}

test("with the split configured, credential pages and the rest of the site never share a host", async () => {
  process.env.NEXT_PUBLIC_ACR_OPS_ORIGIN = "https://ops.arccomputerate.in";
  try {
    assert.deepEqual(await hop("https://arccomputerate.in/ops"), { status: 307, to: "https://ops.arccomputerate.in/ops" });
    assert.equal((await hop("https://arccomputerate.in/spend?business=acr-fleet")).to,
      "https://ops.arccomputerate.in/spend?business=acr-fleet");
    assert.equal((await hop("https://ops.arccomputerate.in/curve")).to, "https://arccomputerate.in/curve");
    assert.equal((await hop("https://ops.arccomputerate.in/")).to, "https://arccomputerate.in/");
    process.env.NEXT_PUBLIC_ACR_SITE_ORIGIN = "https://acr.example";
    assert.equal((await hop("https://ops.arccomputerate.in/tape")).to, "https://acr.example/tape", "explicit site origin wins");
    delete process.env.NEXT_PUBLIC_ACR_SITE_ORIGIN;
    // Links name the serving host outright, so the router never meets the redirect.
    assert.equal(hostHref("/spend?business=acr-fleet"), "https://ops.arccomputerate.in/spend?business=acr-fleet");
    assert.equal(hostHref("/curve"), "https://arccomputerate.in/curve");
    // Served where they are, on both hosts.
    for (const u of [
      "https://arccomputerate.in/curve", "https://arccomputerate.in/api/ops/actions",
      "https://ops.arccomputerate.in/developers#mcp", "https://ops.arccomputerate.in/api/futures",
      "https://ops.arccomputerate.in/og/home",
    ]) assert.equal((await hop(u)).to, null, u);
  } finally {
    delete process.env.NEXT_PUBLIC_ACR_OPS_ORIGIN;
  }
});

test("the chain choice is shared with the ops host, not reset to mainnet", () => {
  const chain = readFileSync(join(ROOT, "lib/useChain.ts"), "utf8");
  assert.match(chain, /domain=\$\{parent\}/, "setChain must scope the cookie to the parent domain under the split");
});

test("unset, the proxy does nothing and links stay relative", async () => {
  assert.equal((await hop("https://arc-compute-rate.vercel.app/ops")).to, null);
  assert.equal(hostHref("/ops"), "/ops");
  const layout = readFileSync(join(ROOT, "app/layout.tsx"), "utf8");
  assert.match(layout, /onOps \?/, "the layout must skip the drawer on the ops host");
});
