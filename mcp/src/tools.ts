/** The tool surface, separated from the transport so it can be tested.
 *
 * Every tool is a thin HTTP client over the ACR API. Deliberately: the TCA and
 * rating arithmetic lives in one place (services/index_api), and a plugin that
 * recomputed any of it would be a second implementation to keep in step — and
 * the first time they disagreed, a judge would be looking at two different
 * answers to the same question with no way to tell which was the benchmark.
 */

export const DEFAULT_API = "https://acr-api-1fto.onrender.com";

export interface Fetchish {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const ADDRESS = { type: "string", description: "an 0x address" };
const DAYS = { type: "number", description: "window in days (default 7)" };

export const TOOLS: ToolDef[] = [
  {
    name: "my_tca",
    description:
      "Transaction-cost analysis for a payer: what its purchases cost against the ACR print " +
      "it could have seen at the moment of each trade. Returns volume-weighted slippage in " +
      "basis points, USDC overpaid, and a per-seller breakdown.",
    inputSchema: { type: "object", properties: { target: ADDRESS, days: DAYS }, required: ["target"] },
  },
  {
    name: "reroute_suggestion",
    description:
      "Which seller this payer's volume would have cost less with, computed from its own past " +
      "fills. A suggestion about observed history, not a promise about future fills.",
    inputSchema: { type: "object", properties: { target: ADDRESS, days: DAYS }, required: ["target"] },
  },
  {
    name: "seller_rating",
    description:
      "Grade a seller A-D from the public tape. Always returns n, the synthetic share, and the " +
      "share of the published methodology the grade actually rests on — components with no data " +
      "yet are excluded from the weighting rather than scored zero.",
    inputSchema: { type: "object", properties: { seller: ADDRESS, days: DAYS }, required: ["seller"] },
  },
  {
    name: "benchmark_price",
    description:
      "Compare a quoted unit price against the current ACR print for that index — the same " +
      "arrival comparison the tape applies to a settled purchase, before you pay it.",
    inputSchema: {
      type: "object",
      properties: {
        price: { type: "number", description: "quoted price per unit, USDC" },
        index_id: { type: "string", description: "ACR-INF | ACR-GPU | ACR-DATA" },
      },
      required: ["price", "index_id"],
    },
  },
  {
    name: "get_rate",
    description: "The current ACR print for an index, with its confidence interval and attack-cost bound.",
    inputSchema: {
      type: "object",
      properties: { index_id: { type: "string" } },
      required: ["index_id"],
    },
  },
  {
    name: "query_tape",
    description:
      "Run one of the tape's published read operations against the subgraph through ACR's " +
      "proxy. Call with no operation to list what is available.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string" },
        variables: { type: "object" },
      },
    },
  },
];

async function readJson(fetchImpl: Fetchish, url: string): Promise<unknown> {
  const res = await fetchImpl(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A 402 is not a failure here — it is the gate telling an agent the price.
    return { error: `HTTP ${res.status}`, body };
  }
  return body;
}

/** Dispatch one tool call. Returns the payload the host will render. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: { api?: string; fetchImpl?: Fetchish } = {},
): Promise<unknown> {
  const api = (opts.api ?? DEFAULT_API).replace(/\/$/, "");
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as Fetchish);
  const days = typeof args.days === "number" ? args.days : 7;

  switch (name) {
    case "my_tca":
      return readJson(f, `${api}/tca/${String(args.target)}?days=${days}`);

    case "reroute_suggestion": {
      const tca = (await readJson(f, `${api}/tca/${String(args.target)}?days=${days}`)) as {
        available?: boolean;
        reroute?: unknown;
      };
      if (!tca?.available) return tca;
      // Say so explicitly rather than returning null: "no suggestion" and "the
      // tape was unreadable" are different answers and an agent acts on them
      // differently.
      return tca.reroute ?? { reroute: null, reason: "no cheaper seller in this window" };
    }

    case "seller_rating":
      return readJson(f, `${api}/rating/${String(args.seller)}?days=${days}`);

    case "get_rate":
      return readJson(f, `${api}/onchain/${String(args.index_id)}`);

    case "benchmark_price": {
      const print = (await readJson(f, `${api}/onchain/${String(args.index_id)}`)) as {
        value?: number;
      };
      const arrival = typeof print?.value === "number" ? print.value : null;
      const price = Number(args.price);
      if (arrival === null || !(arrival > 0)) {
        return { available: false, reason: "no on-chain print to compare against" };
      }
      return {
        available: true,
        index_id: args.index_id,
        quoted: price,
        arrival,
        // Same convention the mappings use for a settled purchase, so a quote
        // and a fill are measured the same way.
        slippage_bp: Math.round(((price - arrival) / arrival) * 1e4 * 10) / 10,
        basis: "the latest on-chain ACR print",
      };
    }

    case "query_tape": {
      if (!args.operation) return readJson(f, `${api}/graph/operations`);
      const res = await f(`${api}/graph/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: args.operation, variables: args.variables ?? {} }),
      });
      return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    }

    default:
      return { error: `unknown tool ${name}`, tools: TOOLS.map((t) => t.name) };
  }
}
