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
      'basis points, USDC overpaid, and a per-seller breakdown. Pass "me" to get one figure ' +
      "across every wallet a verified human is resolved to, without naming any of them.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            'an 0x address, or "me" for the calling human\'s own wallets unioned together',
        },
        days: DAYS,
      },
      required: ["target"],
    },
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

async function readJson(
  fetchImpl: Fetchish,
  url: string,
  headers?: Record<string, string>,
): Promise<unknown> {
  const res = await fetchImpl(url, headers ? { headers } : undefined);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A 402 is not a failure here — it is the gate telling an agent the price.
    // Nor is a 401: it is the human gate handing back a nonce to answer.
    return { error: `HTTP ${res.status}`, body };
  }
  return body;
}

/**
 * Ask /tca/human, answering its challenge.
 *
 * The nonce is single-use, so a proof cannot be a static credential in an env
 * var — every call has to take a fresh challenge and answer that one. In dev
 * the answer is derived from a nullifier the host supplies.
 *
 * A real AgentKit proof cannot be minted here at all: it comes from the agent's
 * own World credential, and this plugin has no access to one. Saying so beats
 * returning something that looks like a verified answer and is not.
 */
async function humanTca(
  f: Fetchish,
  api: string,
  days: number,
  nullifier?: string,
  humanKey?: string,
): Promise<unknown> {
  const url = `${api}/tca/human?days=${days}`;
  const challenge = await f(url);
  const body = (await challenge.json().catch(() => ({}))) as {
    nonce?: string;
    scheme?: string;
    header?: string;
    resource?: string;
  };
  if (challenge.ok) return body; // already authorized upstream
  if (!body?.nonce) return { available: false, reason: "the gate issued no challenge", body };
  const header = body.header ?? "HUMAN-PROOF";

  /* Two gates, two proofs. The dev gate takes a bare nullifier; the AgentKit gate
     takes a signed CAIP-122 message from a wallet registered in AgentBook, which
     this plugin CAN produce when the host lends it that wallet's key — the same
     flow `scripts/prove_human.py` runs. Neither credential is ever put in a URL. */
  if (body.scheme === "agentkit") {
    if (!humanKey) {
      return {
        available: false,
        reason:
          "this gate verifies AgentKit proofs: set ACR_HUMAN_AGENT_KEY to the key of a wallet " +
          "registered in AgentBook (a demo buyer's key derives from its public label), and " +
          "the plugin signs the challenge for you. ACR_HUMAN_NULLIFIER is for the dev gate only.",
        challenge: body,
      };
    }
    const proof = await signAgentKitChallenge(humanKey, body.nonce, body.resource ?? "/tca/human", api);
    return readJson(f, url, { [header]: proof });
  }
  if (!nullifier) {
    return {
      available: false,
      reason:
        "no human proof available to this plugin. Set ACR_HUMAN_NULLIFIER for the dev " +
        "gate, or call /tca/human directly with a proof minted from your own World " +
        "credential.",
      challenge: body,
    };
  }
  return readJson(f, url, { [header]: `humanid ${nullifier}:${body.nonce}` });
}

/** A CAIP-122 message naming the gate's nonce and resource, signed EIP-191 by the
 *  wallet, carried as base64 JSON — the shape `AgentKitVerifier` reads. Exported
 *  so a test can pin the wire form without a network. */
export async function signAgentKitChallenge(
  key: string,
  nonce: string,
  resource: string,
  api: string,
): Promise<string> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(key.trim() as `0x${string}`);
  const issuedAt = new Date().toISOString();
  const host = api.replace(/^https?:\/\//, "");
  const raw =
    `${host} wants you to sign in with your account:\n${account.address}\n\n` +
    `URI: ${resource}\nVersion: 1\nChain ID: 480\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
  const signature = await account.signMessage({ message: raw });
  const payload = {
    address: account.address,
    nonce,
    issuedAt,
    uri: resource,
    chainId: "eip155:480",
    signedMessage: raw,
    signature,
    type: "eip191",
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/** Dispatch one tool call. Returns the payload the host will render. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: { api?: string; fetchImpl?: Fetchish; nullifier?: string; humanKey?: string } = {},
): Promise<unknown> {
  const api = (opts.api ?? DEFAULT_API).replace(/\/$/, "");
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as Fetchish);
  const days = typeof args.days === "number" ? args.days : 7;

  switch (name) {
    case "my_tca":
      return String(args.target) === "me"
        ? humanTca(f, api, days, opts.nullifier, opts.humanKey)
        : readJson(f, `${api}/tca/${String(args.target)}?days=${days}`);

    case "reroute_suggestion": {
      const tca = (await (String(args.target) === "me"
        ? humanTca(f, api, days, opts.nullifier, opts.humanKey)
        : readJson(f, `${api}/tca/${String(args.target)}?days=${days}`))) as {
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
