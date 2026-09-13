import assert from "node:assert/strict";
import test from "node:test";
import { TOOLS, snippets } from "../components/chain/McpSnippet";

test("the MCP config names the API this page looks at, and every tool the server registers", () => {
  const s = snippets("https://acr.test");
  assert.match(s.config, /"ACR_API": "https:\/\/acr.test"/);
  assert.ok(JSON.parse(s.config).mcpServers["acr-tca"], "the config must be valid JSON a host can paste");
  for (const t of TOOLS) assert.match(s.ask + s.config + TOOLS.join(), new RegExp(t));
  // The six tools are the ones mcp/src/tools.ts serves — pinned by name so a
  // renamed tool cannot leave this page teaching the old one.
  assert.deepEqual([...TOOLS].sort(), ["benchmark_price", "get_rate", "my_tca", "query_tape", "reroute_suggestion", "seller_rating"]);
});
