import { baseState, servedPaths } from "@/lib/api";
import { servesPath } from "@/lib/apiBase";
import { requestChain } from "@/lib/envelope";
import { handleMcp, hostedPress } from "@/lib/mcpHosted";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// A cold press answers in up to ~19 s; one tool call must fit with room to spare.
export const maxDuration = 60;

/* ACR's hosted MCP server. The URL a remote MCP client adds:
 *
 *   /api/mcp?chain=mainnet   /api/mcp?chain=testnet
 *
 * The chain lives in the URL because a remote client sends no cookie;
 * `requestChain` reads the param first, so a URL that says testnet is always
 * answered from the testnet press. Everything else is lib/mcpHosted.ts, kept
 * out of this file so the tests can drive it with plain Request objects. */
async function handle(req: Request): Promise<Response> {
  const chain = requestChain(req);
  const url = new URL(req.url);
  return handleMcp(req, {
    chain,
    websiteUrl: `${url.origin}/developers#mcp`,
    log: (line) => console.log(line),
    // No network: what the handshake names before any tool is called.
    quickPress: () => hostedPress(chain, baseState(chain).active, null),
    press: async () => {
      const { active } = baseState(chain);
      if (chain === "testnet") return hostedPress(chain, active, null);
      // Mainnet's active press is used only when it is known to serve /par;
      // a route list that cannot be read is not evidence that it does.
      const served = await Promise.race([
        servedPaths(chain),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6_000)),
      ]);
      return hostedPress(chain, active, served ? servesPath(served, "/par") : null);
    },
  });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
