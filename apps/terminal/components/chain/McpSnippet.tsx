"use client";

import { useState } from "react";

import { Ed } from "@/components/Ed";

/* Ask the Tape from an MCP host — the config a developer pastes, and what to say.
 *
 * Sibling of AgentCardSnippet. That one writes the code an agent needs to present
 * a card; this one writes the config a Claude (or any MCP host) needs to call the
 * tape as six read-only tools, and three questions worth asking it. Nothing here
 * spends money or needs a wallet; the private key is for the CARD, so the calls
 * land in the carded tier rather than the shared anonymous ceiling, and it may be
 * any 32-byte key at all.
 */

type Tab = "config" | "ask";

export const TOOLS = ["my_tca", "reroute_suggestion", "seller_rating", "benchmark_price", "get_rate", "query_tape"] as const;

/** The two snippets, built from the API this page is looking at. Pure, so a test can pin them. */
export function snippets(api: string): Record<Tab, string> {
  return {
    config: `{
  "mcpServers": {
    "acr-tca": {
      "command": "npx",
      "args": ["tsx", "/path/to/ACR/mcp/src/server.ts"],
      "env": {
        "ACR_API": "${api}",
        "ACR_AGENT_PRIVATE_KEY": "0x<any 32-byte key: the card, not a wallet>",
        "ACR_HUMAN_AGENT_KEY": "0x<optional: a wallet in AgentBook, for my_tca(\\"me\\")>"
      }
    }
  }
}`,
    ask: `# Three things to ask, once the server is in your host's config:

"What did 0x674055533B05Ec3fD135fC21c4d91a4A2D3193d3 overpay this week, and where should it buy instead?"
#   -> my_tca + reroute_suggestion: slippage vs the benchmark, the seller to leave, the saving in bp

"Rate seller 0xefe0E4625AFf072c3FCff230b47f8150A17aDF19 for me."
#   -> seller_rating: fairness, how many distinct PEOPLE bought there, what share of the grade is measured

"How many settlements landed on the tape in the last hour, and how many were human-backed?"
#   -> query_tape("settlements"): the subgraph's own rows, benchmarked in the mapping`,
  };
}

export function McpSnippet({ api }: { api: string }) {
  const [tab, setTab] = useState<Tab>("config");
  const [copied, setCopied] = useState(false);
  const code = snippets(api)[tab];

  async function copy() {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — the text is selectable */
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <Ed x="Ask the Tape" p="Ask the receipts" className="label" />
      </div>
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 13, maxWidth: 68 * 9, marginTop: 0 }}
        x="Six read-only tools any MCP host can call: a wallet's transaction costs, the seller to switch to, a seller's rating, the benchmark, the on-chain rate, and any named tape query. Every call carries a card; nothing spends."
        p="Six questions an AI assistant can ask the tape: what a wallet paid, where to buy instead, how good a seller is, and the rate itself."
      />
      <div className="register-row" style={{ fontSize: 13 }}>
        <span className="muted" style={{ minWidth: 132 }}>
          <Ed x="tools" p="questions" />
        </span>
        <span className="mono">{TOOLS.join(" · ")}</span>
      </div>

      <div style={{ marginTop: 14, display: "flex", gap: 6, alignItems: "center" }}>
        <Ed x="Paste, then ask" p="Set it up, then ask" className="label" />
        {(["config", "ask"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`mini-btn${tab === t ? " green" : ""}`}
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
          >
            {t === "config" ? <Ed x="host config" p="setup" /> : <Ed x="what to ask" p="questions" />}
          </button>
        ))}
      </div>
      <div className="specimen" style={{ marginTop: 8 }}>
        <button type="button" className="copy-btn" onClick={copy}>
          {copied ? <Ed x="copied" p="copied" /> : <Ed x="copy" p="copy" />}
        </button>
        <pre style={{ maxHeight: 360, overflow: "auto", paddingRight: 64 }}>{code}</pre>
      </div>
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 12.5, marginTop: 8 }}
        x="The same answers the buyer agent acts on and this page renders, handed to a model as tools. The repo's mcp/README.md is the long form."
        p="The same answers the buying robot uses, given to an AI assistant as tools it can call."
      />
    </section>
  );
}
