/* The hosted ACR MCP server: the published `acr-mcp` tool layer behind a URL.
 *
 * WHY IT EXISTS. ACR's MCP plugin was local-only (`npx -y acr-mcp`, stdio), so
 * a team that wanted to point its agent at ACR had to install a package before
 * it could find out whether the thing answered. A remote-MCP URL is what every
 * current client adds in one step (Claude.ai connectors, `claude mcp add
 * --transport http`, Cursor, VS Code), and it is what /developers now hands out.
 *
 * WHAT RUNS. `callTool` / `toolsFor` from `acr-mcp@0.3.3`, the same published
 * code `npx -y acr-mcp` runs (pinned and name-checked against mcp/src by
 * lib/mcpHosted.test.ts), behind the SDK's web-standard Streamable HTTP
 * transport in STATELESS JSON mode: one fresh server per request, no session,
 * no stream. That shape suits a serverless function, where two requests from
 * one client may land on two instances.
 *
 * WHAT IT WILL NOT DO, and each line is a test:
 *  - pay (`pay_and_read`) or keep a ledger (`spend_report`): those need the
 *    caller's own key and machine, so they are refused BY NAME, not hidden;
 *  - read anything from this server's environment: every call gets the fixed
 *    `HOSTED_ENV`, because the tool layer otherwise falls back to process.env
 *    and `can_i_pay` would print this deployment's RPC URL to a stranger;
 *  - reach any host but the chain's press, or forward a caller's headers;
 *  - put an unchecked argument into a press URL (`/tca/${target}`).
 *
 * Server-only. Never imported by a component (lib/mcpHosted.test.ts scans).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_API, callTool, toolsFor, type Fetchish, type ToolDef } from "acr-mcp";

import { CHAINS, type ChainKey } from "./chainChoice";
import { ACR_MCP_VERSION, HOSTED_TOOLS, LOCAL_ONLY } from "./mcpPlayground";

/** The only environment the tool layer ever sees here. "off" makes
 *  `check_spend` answer `recorded_to: null` without touching a filesystem. */
export const HOSTED_ENV = Object.freeze({ ACR_SPEND_LOG: "off" }) as unknown as NodeJS.ProcessEnv;

/** A cold testnet press was measured at 18-19 s to first answer. */
export const UPSTREAM_TIMEOUT_MS = 25_000;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 4;

const HOSTED = new Set<string>(HOSTED_TOOLS);

/** The press a chain's hosted endpoint reads: the same host the /developers
 *  snippet pins. Testnet: the active testnet press. Mainnet: the active press
 *  only when it is KNOWN to serve /par, else the package's own default (the
 *  probe), because a mainnet press without /par cannot price a bill. */
export function hostedPress(chain: ChainKey, active: string, servesPar: boolean | null): string {
  if (chain === "testnet") return active;
  return servesPar === true ? active : DEFAULT_API;
}

/** What `tools/list` answers: the package's read-only tools, minus the one that
 *  reads a local file, each told it is running hosted. */
export function hostedTools(): ToolDef[] {
  const suffix: Record<string, string> = {
    check_spend: " Hosted: nothing is recorded here; for a running ledger use the local package (npx -y acr-mcp).",
    can_i_pay:
      " Hosted: it stops at the payer step by design, because paying needs your own key in the local package (npx -y acr-mcp).",
    wallet_tca: ' Hosted: pass a 0x address; "me" needs a human credential, which only the local package holds.',
    reroute_suggestion: ' Hosted: pass a 0x address; "me" needs the local package.',
  };
  return toolsFor(false)
    .filter((t) => HOSTED.has(t.name))
    .sort((a, b) => HOSTED_TOOLS.indexOf(a.name as never) - HOSTED_TOOLS.indexOf(b.name as never))
    .map((t) => (suffix[t.name] ? { ...t, description: t.description + suffix[t.name] } : t));
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const INDEX_ID = /^ACR-[A-Z]{2,10}$/;
const OPERATION = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PLAIN_PATH = /^\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

/** Null when the arguments are safe to send, else the sentence saying why not.
 *  Every value that lands in a press URL is checked here, before any fetch. */
export function checkArgs(name: string, args: Record<string, unknown>): string | null {
  const a = args ?? {};
  const address = (k: string, required: boolean): string | null => {
    const v = a[k];
    if (v === undefined || v === null || v === "") return required ? `${k} is required` : null;
    return typeof v === "string" && ADDRESS.test(v.trim()) ? null : `${k} must be a 0x wallet address (40 hex characters)`;
  };
  const bounded = (k: string, lo: number, hi: number): string | null => {
    const v = a[k];
    if (v === undefined || v === null) return null;
    return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? null : `${k} must be a number from ${lo} to ${hi}`;
  };
  switch (name) {
    case "wallet_tca":
    case "reroute_suggestion":
      if (a.target === "me") {
        return '"me" needs a human credential, which only the local package holds (npx -y acr-mcp with ACR_HUMAN_AGENT_KEY); pass a 0x address here';
      }
      return address("target", true) ?? bounded("days", 1, 365);
    case "seller_rating":
      return address("seller", true) ?? bounded("days", 1, 365);
    case "payment_receipts":
      return address("payer", false) ?? bounded("limit", 1, 100);
    case "check_spend":
      return address("vendor", false);
    case "benchmark_price": {
      const id = a.index_id;
      if (id !== undefined && id !== null && id !== "" && !(typeof id === "string" && INDEX_ID.test(id))) {
        return "index_id must look like ACR-INF";
      }
      return null;
    }
    case "get_rate":
      return typeof a.index_id === "string" && INDEX_ID.test(a.index_id) ? null : "index_id must look like ACR-INF";
    case "query_tape": {
      const op = a.operation;
      if (op !== undefined && op !== null && !(typeof op === "string" && OPERATION.test(op))) return "operation must be a plain name";
      const vars = a.variables;
      if (vars === undefined || vars === null) return null;
      if (typeof vars !== "object" || Array.isArray(vars)) return "variables must be an object";
      return JSON.stringify(vars).length <= 2048 ? null : "variables must be under 2 KB";
    }
    case "can_i_pay": {
      const ep = a.endpoint;
      if (ep === undefined || ep === null || ep === "") return null;
      return typeof ep === "string" && ep.length <= 80 && PLAIN_PATH.test(ep) ? null : "endpoint must be a plain path like /prints";
    }
    default:
      return null;
  }
}

const HOSTED_NOTE = "answered by ACR's hosted MCP server: read-only, nothing stored, no keys";

/** The tool's own answer, plus what it means that it ran hosted. */
export function annotate(name: string, out: unknown): unknown {
  if (!out || typeof out !== "object" || Array.isArray(out)) return out;
  const o: Record<string, unknown> = { ...(out as Record<string, unknown>), hosted: HOSTED_NOTE };
  if (name === "can_i_pay" && o.blocked_at === "payer") {
    o.next_step =
      "Everything up to paying checks out. To pay, run the local package with your own wallet key: npx -y acr-mcp with ACR_PAYER_PRIVATE_KEY (see /developers).";
  }
  return o;
}

/** A payload the host should render as a failure. A 402 is NOT one: it is the
 *  gate quoting a price, which is the whole subject (mirrors mcp/src/server.ts). */
export function isFailure(out: unknown): boolean {
  if (!out || typeof out !== "object") return false;
  const err = (out as { error?: unknown }).error;
  if (typeof err !== "string" || !err) return false;
  return !/^HTTP 402$/.test(err);
}

/** The fetch the tool layer gets: the press's origin only, no caller headers,
 *  never cached, bounded in time. */
export function pressFetch(api: string, timeoutMs = UPSTREAM_TIMEOUT_MS, f: typeof fetch = fetch): Fetchish {
  const origin = new URL(api).origin;
  return async (url, init) => {
    if (new URL(url).origin !== origin) throw new Error(`refused: ${new URL(url).host} is not this chain's press`);
    return f(url, {
      method: init?.method ?? "GET",
      headers: { ...(init?.headers ?? {}), "user-agent": `acr-mcp-hosted/${ACR_MCP_VERSION}` },
      body: init?.body,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  };
}

const text = (s: string) => [{ type: "text" as const, text: s }];

/** One MCP server for one request. Built fresh every time: a stateless
 *  transport cannot be reused, and a shared server would serialise callers. */
export function buildServer(o: {
  chain: ChainKey;
  api: string;
  fetchImpl: Fetchish;
  retryDelayMs?: number;
  websiteUrl?: string;
  log?: (line: string) => void;
}): Server {
  const chainName = CHAINS[o.chain].profile.name;
  const server = new Server(
    {
      name: "acr-tca",
      version: ACR_MCP_VERSION,
      title: `ACR Machine TCA · hosted · ${chainName}`,
      ...(o.websiteUrl ? { websiteUrl: o.websiteUrl } : {}),
    },
    {
      capabilities: { tools: {} },
      instructions:
        `ACR prices machine spend on ${chainName}: check a bill against the going rate before paying (check_spend), ` +
        `grade an agent wallet's purchases (wallet_tca), rate a seller, read the on-chain index (get_rate). ` +
        `Read-only and keyless; answers come from ${new URL(o.api).host}. ` +
        `Paying (pay_and_read) and a spend ledger (spend_report) need the local package: npx -y acr-mcp.`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: hostedTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const t0 = Date.now();
    if (name in LOCAL_ONLY) {
      const why = LOCAL_ONLY[name as keyof typeof LOCAL_ONLY];
      return {
        content: text(`${name} runs only in the local package (npx -y acr-mcp): it ${why}. The hosted server is read-only.`),
        isError: true,
      };
    }
    if (!HOSTED.has(name)) return { content: text(`unknown tool: ${name}`), isError: true };
    const bad = checkArgs(name, args);
    if (bad) return { content: text(`${name}: ${bad}`), isError: true };

    let out: unknown;
    try {
      out = await callTool(name, args, {
        api: o.api,
        fetchImpl: o.fetchImpl,
        env: HOSTED_ENV,
        ...(o.retryDelayMs !== undefined ? { retryDelayMs: o.retryDelayMs } : {}),
      });
    } catch {
      out = {
        available: false,
        error: "the press did not answer in time; it sleeps between visits, so ask again",
        host_side: true,
      };
    }
    const failed = isFailure(out);
    o.log?.(`[mcp] ${o.chain} ${name} ${Date.now() - t0}ms ${failed ? "fail" : "ok"}`);
    return {
      content: text(JSON.stringify(annotate(name, out), null, 2)),
      ...(failed ? { isError: true } : {}),
    };
  });

  return server;
}

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, x-acr-chain, x-acr-press",
  "access-control-max-age": "86400",
};

function jsonRpcError(status: number, code: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS, ...extra },
  });
}

export interface HostedDeps {
  chain: ChainKey;
  /** Resolved lazily, and only for a message that calls a tool: OPTIONS, GET,
   *  `initialize` and `tools/list` never wait on a press. */
  press: () => Promise<string>;
  /** A no-network guess at the same press, for messages that do not call a
   *  tool (it names the host in the instructions and the x-acr-press header).
   *  Defaults to the package's own default press. */
  quickPress?: () => string;
  fetchImpl?: Fetchish;
  retryDelayMs?: number;
  websiteUrl?: string;
  log?: (line: string) => void;
}

/** Whether a JSON-RPC message, or any message in a batch, calls a tool. */
export function callsATool(msg: unknown): boolean {
  const one = (m: unknown) => Boolean(m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call");
  return Array.isArray(msg) ? msg.some(one) : one(msg);
}

/** The whole endpoint, as a Request → Response function a route (or a test)
 *  can call. */
export async function handleMcp(req: Request, deps: HostedDeps): Promise<Response> {
  const method = req.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (method !== "POST") {
    // Caught BEFORE the transport: in stateless mode it would answer GET by
    // opening an event stream that hangs until the function's time limit.
    return jsonRpcError(
      405,
      -32000,
      "ACR's MCP endpoint speaks Streamable HTTP over POST (stateless, JSON responses). " +
        "Add this URL to an MCP client, or try it on /developers.",
      { allow: "POST, OPTIONS" },
    );
  }

  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return jsonRpcError(413, -32600, `request body over ${MAX_BODY_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return jsonRpcError(400, -32700, "parse error: the body is not JSON");
  }
  if (Array.isArray(parsed) && parsed.length > MAX_BATCH) {
    return jsonRpcError(400, -32600, `at most ${MAX_BATCH} messages per batch`);
  }

  // JSON mode never streams, so a client that only accepts JSON is answered too.
  const headers = new Headers(req.headers);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  const normalized = new Request(req.url, { method: "POST", headers, body: JSON.stringify(parsed) });

  /* A client adding this URL shakes hands (initialize, tools/list) before it
     calls anything, and some give up on a slow handshake. Resolving the press
     for those meant a mainnet route-list read (up to 6 s) and, on a sleeping
     press, worse, for messages that never touch it. */
  let api: string;
  if (callsATool(parsed)) {
    try {
      api = await deps.press();
    } catch {
      api = DEFAULT_API;
    }
  } else {
    api = deps.quickPress?.() ?? DEFAULT_API;
  }
  const server = buildServer({
    chain: deps.chain,
    api,
    fetchImpl: deps.fetchImpl ?? pressFetch(api),
    retryDelayMs: deps.retryDelayMs,
    websiteUrl: deps.websiteUrl,
    log: deps.log,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(normalized, { parsedBody: parsed });
    const out = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) out.set(k, v);
    out.set("cache-control", "no-store");
    out.set("x-acr-chain", deps.chain);
    out.set("x-acr-press", new URL(api).host);
    return new Response(res.body, { status: res.status, headers: out });
  } catch (e) {
    return jsonRpcError(500, -32603, `internal error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
