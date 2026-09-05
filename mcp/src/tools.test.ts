import { test } from "node:test";
import assert from "node:assert/strict";

import { callTool, TOOLS } from "./tools.js";

/** A fetch stand-in that records calls and replays canned bodies. */
function fake(routes: Record<string, unknown>, seen: string[] = []) {
  return async (url: string, init?: { method?: string; body?: string }) => {
    seen.push(`${init?.method ?? "GET"} ${url}`);
    const key = Object.keys(routes).find((k) => url.includes(k));
    return {
      ok: key !== undefined,
      status: key === undefined ? 404 : 200,
      json: async () => (key === undefined ? {} : routes[key]),
    };
  };
}

test("every tool declares a schema the host can render", () => {
  for (const t of TOOLS) {
    assert.ok(t.name && t.description, `${t.name} needs a description`);
    assert.equal(t.inputSchema.type, "object");
  }
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length, "names must be unique");
});

test("my_tca reads the API rather than computing anything itself", async () => {
  const seen: string[] = [];
  const out = await callTool(
    "my_tca",
    { target: "0xabc", days: 30 },
    { api: "https://acr.test", fetchImpl: fake({ "/tca/": { available: true, vw_slippage_bp: 41 } }, seen) },
  );
  assert.deepEqual(out, { available: true, vw_slippage_bp: 41 });
  assert.equal(seen[0], "GET https://acr.test/tca/0xabc?days=30");
});

test("reroute distinguishes 'no cheaper seller' from 'tape unreadable'", async () => {
  const none = await callTool(
    "reroute_suggestion",
    { target: "0xabc" },
    { api: "https://acr.test", fetchImpl: fake({ "/tca/": { available: true, reroute: null } }) },
  );
  assert.equal((none as { reason: string }).reason, "no cheaper seller in this window");

  const down = await callTool(
    "reroute_suggestion",
    { target: "0xabc" },
    { api: "https://acr.test", fetchImpl: fake({ "/tca/": { available: false, reason: "unset" } }) },
  );
  assert.equal((down as { available: boolean }).available, false);
});

test("benchmark_price measures a quote the same way the tape measures a fill", async () => {
  const out = (await callTool(
    "benchmark_price",
    { price: 0.505, index_id: "ACR-INF" },
    { api: "https://acr.test", fetchImpl: fake({ "/onchain/": { value: 0.5 } }) },
  )) as { slippage_bp: number; arrival: number };
  assert.equal(out.arrival, 0.5);
  assert.equal(out.slippage_bp, 100); // +1% == +100 bp
});

test("benchmark_price refuses to compare against a print that does not exist", async () => {
  const out = (await callTool(
    "benchmark_price",
    { price: 0.5, index_id: "ACR-INF" },
    { api: "https://acr.test", fetchImpl: fake({ "/onchain/": {} }) },
  )) as { available: boolean };
  assert.equal(out.available, false);
});

test("query_tape lists the allowlist when called with no operation", async () => {
  const seen: string[] = [];
  await callTool("query_tape", {}, {
    api: "https://acr.test",
    fetchImpl: fake({ "/graph/operations": { operations: ["meta"] } }, seen),
  });
  assert.equal(seen[0], "GET https://acr.test/graph/operations");
});

test("query_tape posts an operation name, never query text", async () => {
  let body = "";
  const out = await callTool("query_tape", { operation: "meta" }, {
    api: "https://acr.test",
    fetchImpl: async (url: string, init?: { method?: string; body?: string }) => {
      body = init?.body ?? "";
      return { ok: true, status: 200, json: async () => ({ available: true }) };
    },
  });
  assert.deepEqual(JSON.parse(body), { operation: "meta", variables: {} });
  assert.deepEqual(out, { available: true });
});

test("an unknown tool names the ones that exist", async () => {
  const out = (await callTool("nope", {}, { fetchImpl: fake({}) })) as { tools: string[] };
  assert.ok(out.tools.includes("my_tca"));
});
