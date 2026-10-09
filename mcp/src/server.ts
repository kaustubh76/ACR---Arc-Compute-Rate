#!/usr/bin/env node
/** ACR Machine TCA, over MCP.
 *
 *   npx -y acr-mcp                 # with ACR_API in the host's env block
 *
 * Registered in an MCP host's config as a stdio server. Eight of the nine tools
 * are reads, including `can_i_pay`, which answers "could this agent pay for a
 * metered query" by asking for a 402 challenge without answering it. So a host
 * can grant this server with no wallet in the loop and still get a real answer
 * about payment.
 *
 * THE ONE TOOL THAT SPENDS. `pay_and_read` settles an x402 query for real. It is
 * not registered at all unless ACR_PAYER_PRIVATE_KEY is set, and it refuses past
 * ACR_MAX_SPEND_USDC (default $0.01 per process) — a paid query is $0.0001, which
 * is the amount that makes a looping agent expensive without ever looking
 * alarming. Use a key you control; never a shared or house key.
 *
 * Two other credentials, neither of which can move funds:
 *   ACR_AGENT_PRIVATE_KEY   the agent CARD. Any 32-byte key; nothing is enrolled.
 *                           Raises the rate-limit bucket from the shared one.
 *   ACR_HUMAN_NULLIFIER     the dev human gate's credential, for `my_tca("me")`.
 *                           Not a spending key, but anyone holding it can read
 *                           that human's transaction costs.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CARD_HEADER, gateChainId, mintCardHeader, withCard } from "./card.js";
import { newLedger } from "./pay.js";
import { callTool, DEFAULT_API, toolsFor, type Fetchish } from "./tools.js";

const api = process.env.ACR_API ?? DEFAULT_API;
const nullifier = process.env.ACR_HUMAN_NULLIFIER;
/* The AgentKit gate's credential: the key of a wallet registered in AgentBook. The
   plugin signs each challenge with it (CAIP-122, EIP-191); it never leaves this
   process. A demo buyer's key derives from its public label — see mcp/README.md. */
const humanKey = (process.env.ACR_HUMAN_AGENT_KEY ?? "").trim() || undefined;
const payerKey = (process.env.ACR_PAYER_PRIVATE_KEY ?? "").trim() || undefined;
const ledger = newLedger(process.env.ACR_MAX_SPEND_USDC);

const rawFetch = globalThis.fetch as unknown as Fetchish;

/* Which chain this card is signed for: the gate's own answer, not a default.
   ACR_ARC_CHAIN_ID overrides, for a fork or a local gate. See card.ts for the
   401 this replaced — the id lives inside the EIP-712 domain, so a wrong one is
   an invalid signature on every call rather than a warning anywhere. */
const resolveChainId = gateChainId(rawFetch, api, process.env.ACR_ARC_CHAIN_ID);

/* The card, wrapped around the ONE fetch every tool uses. ACR_AGENT_PRIVATE_KEY
   makes this server a carded caller; ACR_AGENT_HUMAN_CLUSTER (opt-in, verified on
   chain, a 401 if wrong) lifts it to the human tier. Unset → anonymous, unchanged. */
const claimed = (process.env.ACR_AGENT_HUMAN_CLUSTER ?? "").trim();
const cardKey = (process.env.ACR_AGENT_PRIVATE_KEY ?? "").trim();
const cardOpts = {
  privateKey: cardKey as `0x${string}`,
  name: "acr-mcp" as const,
  role: "reader" as const,
  ...(claimed ? { humanCluster: claimed as `0x${string}` } : {}),
};
const fetchImpl = withCard(rawFetch, { ...cardOpts, chainId: resolveChainId });

/* The settlement goes out through Circle's SDK rather than our wrapped fetch, so
   the card has to be handed to it explicitly. Minted per call: a card never
   outlives its own request. */
async function extraHeaders(): Promise<Record<string, string>> {
  if (!cardKey) return {};
  try {
    const chainId = await resolveChainId();
    if (chainId === null) return {};
    return { [CARD_HEADER]: await mintCardHeader({ ...cardOpts, chainId }) };
  } catch {
    return {}; // an unsignable card is a config problem, not a reason to drop the payment
  }
}

const server = new Server(
  { name: "acr-tca", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolsFor(payerKey !== undefined),
}));

/** Whether a tool's payload is a failure the host should render as one.
 *
 *  It used to not matter, and that is why a server answering 401 to every call
 *  looked like a server answering. `{error: "HTTP 401"}` wrapped in a successful
 *  result reads, to a model and to a person skimming a transcript, as an answer.
 *  A 402 is deliberately NOT an error: it is the gate quoting a price, which is
 *  the whole subject here. */
function isFailure(out: unknown): boolean {
  if (!out || typeof out !== "object") return false;
  const o = out as { error?: unknown };
  const err = typeof o.error === "string" ? o.error : "";
  if (!err) return false;
  if (/^HTTP 402$/.test(err)) return false;
  return true;
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const out = await callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, {
    api,
    nullifier,
    humanKey,
    payerKey,
    ledger,
    extraHeaders,
    fetchImpl,
  });
  return {
    content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    ...(isFailure(out) ? { isError: true } : {}),
  };
});

await server.connect(new StdioServerTransport());
