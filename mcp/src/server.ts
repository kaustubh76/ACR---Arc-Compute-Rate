#!/usr/bin/env node
/** ACR Machine TCA, over MCP.
 *
 *   ACR_API=https://acr-api-1fto.onrender.com npx tsx mcp/src/server.ts
 *
 * Registered in an MCP host's config as a stdio server. Every tool is a read;
 * nothing here spends money or signs anything, so a host can grant it without
 * a wallet in the loop.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { callTool, DEFAULT_API, TOOLS } from "./tools.js";

const api = process.env.ACR_API ?? DEFAULT_API;

const server = new Server(
  { name: "acr-tca", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const out = await callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, {
    api,
  });
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
});

await server.connect(new StdioServerTransport());
