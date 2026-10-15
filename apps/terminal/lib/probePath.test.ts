/* The probe's allowlist (lib/probePath.ts): the visitor's wallet and bill can
 * run, and nothing a probe cannot honestly run gets through. */
import assert from "node:assert/strict";
import test from "node:test";

import { ENDPOINTS, RUNNABLE } from "./endpoints";
import { runnablePath } from "./probePath";

const A = "0xc2903b52a3ad365fd237b78389a2fde99e886999";

test("every exact runnable path still runs, unchanged", () => {
  for (const p of RUNNABLE) assert.equal(runnablePath(p), p);
});

test("a wallet read runs with the visitor's address, rebuilt canonically", () => {
  assert.equal(runnablePath(`/tca/${A}`), `/tca/${A}?days=30`);
  assert.equal(runnablePath(`/rating/${A}?days=90`), `/rating/${A}?days=90`);
  assert.equal(runnablePath(`/tca/${A.toUpperCase().replace("0X", "0x")}?days=7`), `/tca/${A.toUpperCase().replace("0X", "0x")}?days=7`);
});

test("a bill runs as the visitor typed it, rebuilt from parsed parts", () => {
  const vendor = "0xefe0E4625AFf072c3FCff230b47f8150A17aDF19";
  assert.equal(
    runnablePath(`/par?quantity=23&unit=%24%2F1k%20tokens&billed_usdc=0.47&vendor=${vendor}`),
    `/par?unit=%24%2F1k%20tokens&billed_usdc=0.47&quantity=23&vendor=${vendor}`,
  );
  assert.equal(runnablePath("/par?unit=%24%2FGPU-sec&billed_usdc=2&quantity=100"), "/par?unit=%24%2FGPU-sec&billed_usdc=2&quantity=100");
});

test("anything a probe cannot honestly run is refused", () => {
  const refused = [
    "/tca/../health",
    "/tca/0x12",
    `/tca/${A}/x`,
    `/tca/${A}?days=9999`,
    `/tca/${A}?days=30&x=1`,
    `/tca/${A}?days=1&days=2`,
    `/tca/${A}#frag`,
    `//evil.test/tca/${A}`,
    `https://evil.test/tca/${A}`,
    "/par?unit=lb&billed_usdc=1&quantity=1",
    "/par?unit=%24%2FMB&billed_usdc=-1&quantity=1",
    "/par?unit=%24%2FMB&billed_usdc=1&quantity=1&admin=1",
    "/par?unit=%24%2FMB&billed_usdc=1&quantity=1&vendor=0xnope",
    "/prints/ACR-INF",
    "/desk/session",
    "",
    "x".repeat(500),
  ];
  for (const p of refused) assert.equal(runnablePath(p), null, `accepted ${p.slice(0, 60)}`);
  assert.equal(runnablePath(42), null);
});

test("no paid or POST route becomes runnable through a template", () => {
  for (const e of ENDPOINTS) {
    if (e.gate === "x402" || e.method === "POST") {
      const concrete = e.path.replace("{index_id}", "ACR-INF").replace(/\{[a-z_]+\}/g, A);
      assert.equal(runnablePath(concrete), null, `${e.method} ${e.path} became runnable`);
    }
  }
});
