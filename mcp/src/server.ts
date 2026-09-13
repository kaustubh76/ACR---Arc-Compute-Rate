#!/usr/bin/env node
/** ACR Machine TCA, over MCP.
 *
 *   ACR_API=https://acr-api-1fto.onrender.com npx tsx mcp/src/server.ts
 *
 * Registered in an MCP host's config as a stdio server. Every tool is a read —
 * nothing here spends money or signs a transaction, so a host can grant it
 * without a wallet in the loop.
 *
 * One exception to "no credentials": `my_tca("me")` answers a human-proof
 * challenge, and ACR_HUMAN_NULLIFIER is the dev gate's credential for doing so.
 * It is not a spending key and cannot move funds, but it is not nothing either —
 * anyone holding it can read that human's transaction costs. Unset, `my_tca`
 * still works for any named wallet, and "me" says why it cannot answer.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { withCard } from "./card.js";
import { callTool, DEFAULT_API, TOOLS, type Fetchish } from "./tools.js";

const api = process.env.ACR_API ?? DEFAULT_API;
const nullifier = process.env.ACR_HUMAN_NULLIFIER;
/* The AgentKit gate's credential: the key of a wallet registered in AgentBook. The
   plugin signs each challenge with it (CAIP-122, EIP-191); it never leaves this
   process. A demo buyer's key derives from its public label — see mcp/README.md. */
const humanKey = (process.env.ACR_HUMAN_AGENT_KEY ?? "").trim() || undefined;

/* The card, wrapped around the ONE fetch every tool uses. ACR_AGENT_PRIVATE_KEY
   makes this server a carded caller; ACR_AGENT_HUMAN_CLUSTER (opt-in, verified on
   chain, a 401 if wrong) lifts it to the human tier. Unset → anonymous, unchanged. */
const claimed = (process.env.ACR_AGENT_HUMAN_CLUSTER ?? "").trim();
const fetchImpl = withCard(globalThis.fetch as unknown as Fetchish, {
  privateKey: (process.env.ACR_AGENT_PRIVATE_KEY ?? "").trim() as `0x${string}`,
  chainId: Number(process.env.ACR_ARC_CHAIN_ID ?? 5042002),
  name: "acr-mcp",
  role: "reader",
  ...(claimed ? { humanCluster: claimed as `0x${string}` } : {}),
});

const server = new Server(
  { name: "acr-tca", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const out = await callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, {
    api,
    nullifier,
    humanKey,
    fetchImpl,
  });
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
});

await server.connect(new StdioServerTransport());
