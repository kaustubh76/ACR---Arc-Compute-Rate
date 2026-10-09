"use client";

import { useState } from "react";

import { Ed } from "@/components/Ed";

/* Ask the Tape from an MCP host — the config a developer pastes, and what to say.
 *
 * Sibling of AgentCardSnippet. That one writes the code an agent needs to present
 * a card; this one writes the config a Claude (or any MCP host) needs to call the
 * tape as nine tools, and four questions worth asking it.
 *
 * WHAT CHANGED, AND WHY IT MATTERS HERE. The first version of this section said
 * "nothing spends", which was true and was also the problem: a developer who came
 * to find out whether their agent could pay for a metered query could not learn it
 * from any tool. `can_i_pay` answers that, and still spends nothing — it asks the
 * paywall for a price and declines to answer it. `pay_and_read` does spend, and is
 * not registered at all unless the host sets a payer key, which is why the paying
 * config is a separate tab rather than a line in the default one.
 *
 * The two example addresses have rows on the host this page names, at the
 * plugin's default 30-day window — measured, not assumed. Both reported ZERO at
 * the old 7-day default, so the page shipped a demo that demonstrated nothing.
 * `mcp/scripts/smoke.ts` probes the same two addresses, so a press that stops
 * answering for them fails there rather than quietly here.
 */

type Tab = "config" | "pay" | "ask";

export const TOOLS = [
  "check_spend",
  "can_i_pay",
  "pay_and_read",
  "payment_receipts",
  "my_tca",
  "reroute_suggestion",
  "seller_rating",
  "benchmark_price",
  "get_rate",
  "query_tape",
] as const;

/** The three snippets, built from the API this page is looking at. Pure, so a test can pin them. */
export function snippets(api: string): Record<Tab, string> {
  return {
    config: `{
  "mcpServers": {
    "acr-tca": {
      "command": "npx",
      "args": ["-y", "acr-mcp"],
      "env": {
        "ACR_API": "${api}",
        "ACR_AGENT_PRIVATE_KEY": "0x<any 32-byte key: the card, not a wallet>",
        "ACR_HUMAN_AGENT_KEY": "0x<optional: a wallet in AgentBook, for my_tca(\\"me\\")>"
      }
    }
  }
}`,
    pay: `# Add these two and pay_and_read appears. Without them it is not registered at all.
# A metered query is $0.0001, so the cap is what stops a loop, not your attention.

{
  "mcpServers": {
    "acr-tca": {
      "command": "npx",
      "args": ["-y", "acr-mcp"],
      "env": {
        "ACR_API": "${api}",
        "ACR_PAYER_PRIVATE_KEY": "0x<a wallet YOU control, deposited into Circle Gateway>",
        "ACR_MAX_SPEND_USDC": "0.01"
      }
    }
  }
}

# A settlement spends the GATEWAY balance, not the wallet's USDC. can_i_pay says
# "deposit" rather than "ready" when the wallet is funded and the Gateway is not.`,
    ask: `# Five things to ask, once the server is in your host's config:

"I was billed 0.47 USDC for 23 thousand tokens by 0xefe0E4625AFf072c3FCff230b47f8150A17aDF19. Should I pay it?"
#   -> check_spend: the spend agent\u2019s own ten-rung ladder over YOUR invoice, with the published
#      prices it was judged against. No account, no key, no history with ACR needed.

"Can you pay for a metered ACR query right now? If not, what is in the way?"
#   -> can_i_pay: seven rungs — host, chain, card, paywall, challenge, payer key, Gateway funds.
#      Needs no key, and spends nothing: it asks for the 402 and does not answer it.

"What did 0xc2903b52a3ad365fd237b78389a2fde99e886999 overpay last month, and where should it buy instead?"
#   -> my_tca + reroute_suggestion: slippage vs the benchmark, the seller to leave, the saving in bp

"Rate seller 0xefe0E4625AFf072c3FCff230b47f8150A17aDF19, and tell me how much of that grade is actually measured."
#   -> seller_rating: it answers Unrated on a thin tape and says so, rather than scoring the
#      missing components zero — which is the part worth seeing

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
        x="Ten tools any MCP host can call. Nine are reads: check_spend runs the spend agent\u2019s own ladder over any vendor\u2019s invoice, and can_i_pay asks the paywall for a price without answering it. One spends, and only when you set a payer key."
        p="Ten questions an AI assistant can ask, including whether a bill is fair and whether it could pay for something."
      />
      <div className="register-row" style={{ fontSize: 13 }}>
        <span className="muted" style={{ minWidth: 132 }}>
          <Ed x="tools" p="questions" />
        </span>
        <span className="mono">{TOOLS.join(" · ")}</span>
      </div>
      <div className="register-row" style={{ fontSize: 13 }}>
        <span className="muted" style={{ minWidth: 132 }}>
          <Ed x="install" p="install" />
        </span>
        <span className="mono">npx -y acr-mcp</span>
      </div>

      <div style={{ marginTop: 14, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Ed x="Paste, then ask" p="Set it up, then ask" className="label" />
        {(["config", "pay", "ask"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`mini-btn${tab === t ? " green" : ""}`}
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
          >
            {t === "config" ? (
              <Ed x="host config" p="setup" />
            ) : t === "pay" ? (
              <Ed x="let it pay" p="let it pay" />
            ) : (
              <Ed x="what to ask" p="questions" />
            )}
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
