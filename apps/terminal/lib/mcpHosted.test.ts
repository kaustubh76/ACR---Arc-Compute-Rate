/* The hosted MCP endpoint (lib/mcpHosted.ts, app/api/mcp/route.ts).
 *
 * Driven with plain Request objects and a stubbed press, the way a remote MCP
 * client and a real press would drive it, plus once through the MCP SDK's own
 * client, so "a client can connect" is tested by a client. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_API, TOOLS as PACKAGE_TOOLS } from "acr-mcp";

import { annotate, callsATool, checkArgs, handleMcp, hostedPress, MAX_BATCH, type HostedDeps } from "./mcpHosted";
import { ACR_MCP_VERSION, HOSTED_TOOLS, LOCAL_ONLY } from "./mcpPlayground";

const HERE = dirname(fileURLToPath(import.meta.url));
const TERMINAL = join(HERE, "..");
const REPO = join(TERMINAL, "..", "..");
const PRESS = "https://press.test";
const URL_ = "https://acr.test/api/mcp?chain=testnet";

/** A real /par reply from the testnet press (2026-10-15), quotes trimmed. */
const PAR = "{\"unit\":\"$/1k tokens\",\"billed_usdc\":0.47,\"quantity\":23.0,\"vendor\":null,\"vendor_supplied\":false,\"benchmarked_against\":\"market\",\"basket\":{\"index_id\":\"ACR-INF\",\"status\":\"ok\",\"fetched_at\":1791262384.0,\"age_s\":783185.6491291523,\"max_age_s\":2592000.0,\"warn_after_s\":2073600.0,\"rows\":5,\"requested\":10},\"over_rate_bp\":500869.56521739135,\"par\":{\"resource\":\"$/1k tokens\",\"available\":true,\"denomination\":\"unit\",\"reason\":\"\",\"par_usdc\":0.00039999999999999996,\"best_usdc\":0.0002625,\"best_seller\":\"openai/gpt-4o-mini\",\"best_source\":\"market\",\"sellers\":5,\"first_party_sellers\":0,\"basis\":\"market\",\"quotes\":[{\"seller\":\"openai/gpt-4o-mini\",\"price_usdc\":0.0002625,\"source\":\"market\",\"first_party\":false,\"label\":\"GPT-4o mini\",\"url\":\"https://openrouter.ai/api/v1/models\",\"cite\":\"data[id=openai/gpt-4o-mini].pricing\"},{\"seller\":\"qwen/qwen-2.5-72b-instruct\",\"price_usdc\":0.00037,\"source\":\"market\",\"first_party\":false,\"label\":\"Qwen 2.5 72B\",\"url\":\"https://openrouter.ai/api/v1/models\",\"cite\":\"data[id=qwen/qwen-2.5-72b-instruct].pricing\"},{\"seller\":\"meta-llama/llama-3.1-70b-instruct\",\"price_usdc\":0.00039999999999999996,\"source\":\"market\",\"first_party\":false,\"label\":\"Llama 3.1 70B\",\"url\":\"https://openrouter.ai/api/v1/models\",\"cite\":\"data[id=meta-llama/llama-3.1-70b-instruct].pricing\"},{\"seller\":\"deepseek/deepseek-chat\",\"price_usdc\":0.000450225,\"source\":\"market\",\"first_party\":false,\"label\":\"DeepSeek Chat\",\"url\":\"https://openrouter.ai/api/v1/models\",\"cite\":\"data[id=deepseek/deepseek-chat].pricing\"},{\"seller\":\"openai/gpt-4.1-mini\",\"price_usdc\":0.0007,\"source\":\"market\",\"first_party\":false,\"label\":\"GPT-4.1 mini\",\"url\":\"https://openrouter.ai/api/v1/models\",\"cite\":\"data[id=openai/gpt-4.1-mini].pricing\"}]},\"verdict\":{\"benchmarked\":true,\"reason\":\"\",\"billed_usdc\":0.47,\"denomination\":\"unit\",\"par_usdc\":0.00039999999999999996,\"best_usdc\":0.0002625,\"best_seller\":\"openai/gpt-4o-mini\",\"best_source\":\"market\",\"over_par_usdc\":0.4608,\"over_par_bp\":500869.56521739135,\"saving_usdc\":0.4639625,\"saving_bp\":9871.54255319149,\"sellers\":5,\"basis\":\"market\",\"verdict\":\"over_par\",\"note\":\"a suggestion, not a promise\"},\"would\":{\"intent\":\"escalate\",\"rule\":\"500870 bp above the going market rate of 0.0004 across 5 published prices, and the cheaper ones are references rather than addresses we can pay\",\"notes\":[\"no counterparty screen was offered for this decision\"],\"recommended_intent\":\"refuse\"}}";

type Call = { url: string; method: string };

/** A stub press: records every call, answers the routes the tools read. */
function stubPress(opts: { throws?: boolean } = {}) {
  const calls: Call[] = [];
  const now = Math.floor(Date.now() / 1000);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (opts.throws) throw new Error("connect ECONNREFUSED");
    const path = new URL(url).pathname;
    if (path === "/onchain/ACR-INF") {
      return json(200, { source: "onchain", index_id: "ACR-INF", value: 0.4977, ci_lo: 0.49, ci_hi: 0.5, attack_cost_per_bp: 0.01, timestamp: 1, posted_at: now - 600 });
    }
    if (path === "/par") return json(200, JSON.parse(PAR));
    if (path === "/health") return json(200, { status: "ok", chain_id: 5042002, gate: "dev", signer: "none" });
    if (path === "/agent/whoami") return json(200, { carded: false });
    if (path === "/x402/info") return json(200, { mode: "dev", price_usdc: 0.0001, gated_endpoints: ["/prints"] });
    return json(404, { detail: "Not Found" });
  }) as typeof fetch;
  return { calls, f };
}

function deps(p = stubPress(), chain: HostedDeps["chain"] = "testnet"): HostedDeps {
  return { chain, press: async () => PRESS, quickPress: () => PRESS, fetchImpl: p.f as never, retryDelayMs: 0 };
}

let id = 0;
function post(body: unknown, accept = "application/json, text/event-stream"): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept },
    body: JSON.stringify(body),
  });
}
const msg = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) });

async function call(name: string, args: Record<string, unknown>, d = deps()) {
  const res = await handleMcp(post(msg("tools/call", { name, arguments: args })), d);
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const text = body.result.content[0].text;
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    /* a refusal is plain text */
  }
  return { res, isError: Boolean(body.result.isError), payload, text };
}

test("initialize names the server, its version and the chain it reads", async () => {
  const res = await handleMcp(
    post(msg("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })),
    deps(),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-acr-chain"), "testnet");
  assert.equal(res.headers.get("x-acr-press"), "press.test");
  const body = (await res.json()) as { result: { serverInfo: { name: string; version: string }; instructions: string } };
  assert.equal(body.result.serverInfo.name, "acr-tca");
  assert.equal(body.result.serverInfo.version, ACR_MCP_VERSION);
  assert.match(body.result.instructions, /npx -y acr-mcp/);
  assert.match(body.result.instructions, /press\.test/);
});

test("tools/list is exactly the hosted, read-only nine", async () => {
  const res = await handleMcp(post(msg("tools/list")), deps());
  const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.ok(!names.includes("pay_and_read") && !names.includes("spend_report"));
  assert.deepEqual(names, [...HOSTED_TOOLS]);
});

test("get_rate reads only the chain's press, and only the route it needs", async () => {
  const p = stubPress();
  const { isError, payload } = await call("get_rate", { index_id: "ACR-INF" }, deps(p));
  assert.equal(isError, false);
  assert.equal((payload as { value: number }).value, 0.4977);
  assert.deepEqual(p.calls.map((c) => c.url), [`${PRESS}/onchain/ACR-INF`]);
});

test("check_spend prices the bill and records nothing", async () => {
  const { isError, payload } = await call("check_spend", { billed_usdc: 0.47, quantity: 23, unit: "$/1k tokens" });
  const o = payload as { recorded_to: unknown; hosted: string; would: { intent: string } };
  assert.equal(isError, false);
  assert.equal(o.recorded_to, null, "a hosted server keeps no ledger, so nothing can leak between callers");
  assert.match(o.hosted, /read-only/);
  assert.equal(o.would.intent, "escalate");
});

test("paying and the ledger are refused by name, before any upstream call", async () => {
  for (const name of Object.keys(LOCAL_ONLY)) {
    const p = stubPress();
    const { isError, text } = await call(name, { endpoint: "/prints" }, deps(p));
    assert.equal(isError, true, `${name} must be a refusal the client renders as one`);
    assert.match(text, /npx -y acr-mcp/);
    assert.equal(p.calls.length, 0, `${name} reached the press`);
  }
});

test("an argument that would steer a press URL is refused before any fetch", async () => {
  for (const target of ["../health", "me", "0x123", "0xc2903b52a3ad365fd237b78389a2fde99e886999/../../ops"]) {
    const p = stubPress();
    const { isError } = await call("wallet_tca", { target }, deps(p));
    assert.equal(isError, true, `target ${target} was accepted`);
    assert.equal(p.calls.length, 0, `target ${target} reached the press`);
  }
  assert.equal(checkArgs("get_rate", { index_id: "ACR-INF/../x" }) !== null, true);
  assert.equal(checkArgs("can_i_pay", { endpoint: "https://evil.test/x" }) !== null, true);
  assert.equal(checkArgs("wallet_tca", { target: "0xc2903b52a3ad365fd237b78389a2fde99e886999" }), null);
});

test("nothing from this server's environment reaches a caller", async () => {
  const before = { rpc: process.env.ACR_ARC_RPC_URL, key: process.env.ACR_PAYER_PRIVATE_KEY };
  process.env.ACR_ARC_RPC_URL = "https://secret.test/key-abc";
  process.env.ACR_PAYER_PRIVATE_KEY = "0x" + "11".repeat(32);
  try {
    const { text, payload } = await call("can_i_pay", {});
    assert.ok(!text.includes("secret.test"), "the deployment's RPC URL leaked into a tool answer");
    assert.ok(!text.includes("11".repeat(32)), "a key leaked into a tool answer");
    const o = payload as { blocked_at: string; hosted: string; rungs: { rung: string; ok: boolean }[] };
    assert.ok(o.rungs.some((r) => r.rung === "chain"), "the chain rung (which names an RPC) must have run");
    assert.ok(!text.includes("paying as"), "a hosted server must never find a payer key");
    assert.notEqual(o.blocked_at, null);
    assert.match(o.hosted, /no keys/);
  } finally {
    if (before.rpc === undefined) delete process.env.ACR_ARC_RPC_URL;
    else process.env.ACR_ARC_RPC_URL = before.rpc;
    if (before.key === undefined) delete process.env.ACR_PAYER_PRIVATE_KEY;
    else process.env.ACR_PAYER_PRIVATE_KEY = before.key;
  }
});

test("a can_i_pay that stops at the payer step points at the local package", () => {
  const o = annotate("can_i_pay", { blocked_at: "payer", next_step: "set ACR_PAYER_PRIVATE_KEY" }) as { next_step: string };
  assert.match(o.next_step, /npx -y acr-mcp/);
  assert.deepEqual(annotate("get_rate", [1]), [1], "only objects are annotated");
});

test("a press that cannot be reached is a tool error, not a broken endpoint", async () => {
  const { res, isError, text } = await call("get_rate", { index_id: "ACR-INF" }, deps(stubPress({ throws: true })));
  assert.equal(res.status, 200);
  assert.equal(isError, true);
  assert.ok(text.length > 0);
});

test("GET and DELETE answer 405 at once instead of opening a stream", async () => {
  for (const method of ["GET", "DELETE"]) {
    const res = await handleMcp(new Request(URL_, { method, headers: { accept: "text/event-stream" } }), deps());
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST, OPTIONS");
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /POST/);
  }
});

test("a browser preflight is answered with CORS for the MCP headers", async () => {
  const res = await handleMcp(new Request(URL_, { method: "OPTIONS" }), deps());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /mcp-protocol-version/);
  assert.match(res.headers.get("access-control-expose-headers") ?? "", /x-acr-chain/);
});

test("oversized bodies and batches are refused; a JSON-only client is still answered", async () => {
  const big = await handleMcp(post({ jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(70_000) }), deps());
  assert.equal(big.status, 413);
  const batch = await handleMcp(post(Array.from({ length: MAX_BATCH + 1 }, () => msg("tools/list"))), deps());
  assert.equal(batch.status, 400);
  const notJson = await handleMcp(new Request(URL_, { method: "POST", body: "{nope" }), deps());
  assert.equal(notJson.status, 400);
  const plain = await handleMcp(post(msg("tools/list"), "application/json"), deps());
  assert.equal(plain.status, 200, "a client that only accepts JSON must still be answered");
});

test("which press each chain's endpoint reads", () => {
  assert.equal(hostedPress("testnet", "https://t.test", null), "https://t.test");
  assert.equal(hostedPress("testnet", "https://t.test", false), "https://t.test");
  assert.equal(hostedPress("mainnet", "https://m.test", true), "https://m.test");
  assert.equal(hostedPress("mainnet", "https://m.test", false), DEFAULT_API, "a press without /par cannot price a bill");
  assert.equal(hostedPress("mainnet", "https://m.test", null), DEFAULT_API, "an unreadable route list is not evidence");
});

test("the MCP SDK's own client connects, lists and calls", async () => {
  const d = deps();
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      handleMcp(input instanceof Request ? input : new Request(String(input), init), d)) as typeof fetch,
  });
  const client = new Client({ name: "acr-test", version: "1" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, HOSTED_TOOLS.length);
    const out = await client.callTool({ name: "get_rate", arguments: { index_id: "ACR-INF" } });
    const text = (out.content as { type: string; text: string }[])[0].text;
    assert.equal((JSON.parse(text) as { value: number }).value, 0.4977);
  } finally {
    await client.close();
  }
});

test("the hosted server runs the published package this repo ships", () => {
  const pkg = JSON.parse(readFileSync(join(TERMINAL, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const installed = JSON.parse(readFileSync(join(TERMINAL, "node_modules", "acr-mcp", "package.json"), "utf8")) as { version: string };
  const source = JSON.parse(readFileSync(join(REPO, "mcp", "package.json"), "utf8")) as { version: string };
  assert.equal(pkg.dependencies["acr-mcp"], ACR_MCP_VERSION, "package.json must pin the exact version");
  assert.equal(installed.version, ACR_MCP_VERSION);
  assert.equal(source.version, ACR_MCP_VERSION, "mcp/ moved on: publish it and re-pin the terminal");
});

test("the published tools are the ones in mcp/src", () => {
  const src = readFileSync(join(REPO, "mcp", "src", "tools.ts"), "utf8");
  const registered = [...src.matchAll(/^\s{4}name: "([a-z_]+)",$/gm)].map((m) => m[1]);
  assert.deepEqual(PACKAGE_TOOLS.map((t) => t.name).sort(), registered.sort(), "mcp/src changed without a publish");
  assert.deepEqual([...HOSTED_TOOLS, ...Object.keys(LOCAL_ONLY)].sort(), registered.sort(), "every tool is hosted or local-only");
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : sources(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

test("only the route imports the server side; the browser never does", () => {
  const server = /from "(acr-mcp|@modelcontextprotocol\/sdk[^"]*|@\/lib\/mcpHosted|\.\/mcpHosted)"/;
  const allowed = new Set(["app/api/mcp/route.ts", "app/developers/page.tsx", "lib/mcpHosted.ts"]);
  const found = ["app", "components", "lib"]
    .flatMap((d) => sources(join(TERMINAL, d)))
    .filter((f) => server.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(TERMINAL.length + 1))
    .filter((f) => !allowed.has(f));
  assert.deepEqual(found, [], "Node-only code would land in a client bundle");
});

test("the handshake never waits on a press; only a tool call resolves one", async () => {
  let resolved = 0;
  const p = stubPress();
  const d: HostedDeps = {
    chain: "testnet",
    press: async () => {
      resolved += 1;
      return PRESS;
    },
    quickPress: () => "https://quick.test",
    fetchImpl: p.f as never,
    retryDelayMs: 0,
  };
  const init = await handleMcp(
    post(msg("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })),
    d,
  );
  assert.equal(init.headers.get("x-acr-press"), "quick.test", "the handshake names the quick guess");
  await handleMcp(post(msg("tools/list")), d);
  await handleMcp(post([msg("tools/list"), msg("ping")]), d);
  assert.equal(resolved, 0, "a handshake waited on the press");
  await handleMcp(post(msg("tools/call", { name: "get_rate", arguments: { index_id: "ACR-INF" } })), d);
  assert.equal(resolved, 1, "a tool call must resolve the real press");
  assert.equal(callsATool([msg("tools/list"), msg("tools/call")]), true);
  assert.equal(callsATool({ method: "initialize" }), false);
});
