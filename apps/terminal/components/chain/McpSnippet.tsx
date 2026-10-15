"use client";

import { useMemo, useState, useSyncExternalStore } from "react";

import { Ed } from "@/components/Ed";
import { CHAIN, CHAIN_TESTNET } from "@/lib/chain";
import type { ChainKey } from "@/lib/chainChoice";
import { UNITS, type Unit } from "@/lib/indices";
import type { ParQuery } from "@/lib/parQuery";
import type { MarketReceipt } from "@/lib/types";
import { usePlaygroundInputs } from "@/lib/usePlayground";
import {
  ACR_MCP_VERSION,
  CLIENTS,
  CLIENT_LABEL,
  EXAMPLES,
  HOSTED_TOOLS,
  LOCAL_ONLY,
  isRemoteClient,
  liveSubjects,
  mcpUrl,
  readInputs,
  readingOf,
  remoteSetup,
  runTool,
  testConnection,
  toolArgs,
  type ConnectionReport,
  type HostedTool,
  type McpClient,
  type PlaygroundInputs,
  type ToolRun,
} from "@/lib/mcpPlayground";

/* Ask the Tape from an MCP host: a URL to add, your own values to try it with,
 * and the setup for the client you use.
 *
 * IT WAS COPY-PASTE, AND THAT WAS THE COMPLAINT. One stdio config, two example
 * wallets, a fixed bill and a typed-in tool list: a team that came to point its
 * agent at ACR could read the section but not use it. Now:
 *  - ACR hosts the server (app/api/mcp), so the first step is adding a URL, not
 *    installing a package;
 *  - the visitor's wallet and bill go in here, every tool runs live with them,
 *    and "test connection" walks what a client does on first contact;
 *  - the setup is written for the client they pick, with their URL in it.
 * The browser talks MCP to that same URL (lib/mcpPlayground.ts), so a click
 * here is an end-to-end test of what they are about to paste.
 *
 * WHAT STAYS LOCAL, said rather than hidden: `pay_and_read` pays with the
 * caller's own key and `spend_report` reads the caller's own ledger, so both
 * live in `npx -y acr-mcp`, whose config is still here.
 *
 * THE BILL EXAMPLE NAMES NO VENDOR, deliberately. It used to name 0xefe0…, which
 * is ACR's OWN seller, and the press prices a first-party seller only against
 * ACR's fleet, never the market. Measured 2026-10-13 through the published
 * plugin, the same bill came back "pay, unbenchmarked" on mainnet and "pay,
 * -9,609 bp" on testnet, while with no vendor it was "escalate, +500,870 bp"
 * against five cited market prices. `npm run demo` in mcp/ asks this exact
 * question and fails if it stops being priced against the market.
 */

type Tab = "config" | "pay" | "ask" | "aomi";
type View = "setup" | "pay" | "ask" | "answer";

export { EXAMPLES };

/** The Aomi App's chat, pinned. Aomi routes a plain chat on its own (Auto) and
 *  did not pick ACR for these questions; the dashboard's own Chat tab builds
 *  exactly this link (aomi-labs/aomi apps/build/src/lib/chat-url.ts). */
export const AOMI_CHAT =
  "https://chat.aomi.dev/?app=acr-compute-rate&application_id=2938642&lock_app=1";

/** Which press the LOCAL package's config pins, or null to let it choose.
 *
 *  Mainnet: only a press that serves /par (see the note above `McpSnippet` in
 *  developers/view.tsx), else null and the package's own default. TESTNET
 *  ALWAYS PINS: null means the package default, and that default is a MAINNET
 *  press, so a tester on the testnet page would silently get the other chain. */
export function snippetApi(chain: ChainKey, active: string, servesPar: boolean | null): string | null {
  if (chain === "testnet") return active;
  return servesPar === false ? null : active;
}

const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** Every tool the package has. Checked against mcp/src/tools.ts by a test. */
export const TOOLS = [
  "check_spend",
  "spend_report",
  "can_i_pay",
  "pay_and_read",
  "payment_receipts",
  "wallet_tca",
  "reroute_suggestion",
  "seller_rating",
  "benchmark_price",
  "get_rate",
  "query_tape",
] as const;

/** What a visitor's own values change in the text. All optional: with none,
 *  the output is the worked examples, byte for byte. */
export interface SnippetOpts {
  /** Their agent's wallet, already validated. */
  wallet?: string | null;
  /** A seller to rate, already validated (their vendor, or a live one). */
  seller?: string | null;
  /** The window phrase for the subjects above. */
  window?: string;
  /** Their bill, already validated. */
  bill?: ParQuery | null;
  /** The live price of a metered query. */
  priceUsdc?: number | null;
  /** True for a client that adds the HOSTED server, which keeps no ledger. */
  remote?: boolean;
}

function amountOf(bill: ParQuery): string {
  switch (bill.unit) {
    case "$/1k tokens":
      return `${bill.quantity} thousand tokens`;
    case "$/GPU-sec":
      return `${bill.quantity} GPU-seconds`;
    case "$/MB":
      return `${bill.quantity} MB of data`;
  }
}

/** The snippets, built from the API this page is looking at. Pure, so a test can pin them.
 *
 *  `api` IS NULLABLE, AND THAT IS THE POINT. This pinned `ACR_API` to whatever
 *  host the page was looking at, and `baseState().active` is whichever host
 *  last answered: `/terminal/data`, usually, which `acr-api-mainnet` serves
 *  perfectly well while answering 404 for `/par` and all five `/operator/*`.
 *  So the paste-ready config OVERRODE the npm package's own correct default
 *  (`acr-probe-free`) with the one host where five of eleven tools cannot
 *  work. A config that pins the wrong host is worse than one that pins none.
 *
 *  Pass null and the `ACR_API` line is omitted, which is not a degradation:
 *  `acr-mcp` defaults to a mainnet press that serves every tool. The caller
 *  decides by asking the host itself (`servesPath(served, "/par")`) rather than
 *  from a list of hostnames here that would go stale on a rebuild.
 */
export function snippets(api: string | null, chain: ChainKey = "mainnet", opts: SnippetOpts = {}): Record<Tab, string> {
  const ex = EXAMPLES[chain];
  const payer = opts.wallet ?? ex.payer;
  const seller = opts.seller ?? ex.seller;
  const window = opts.window ?? ex.window;
  const price = opts.priceUsdc && opts.priceUsdc > 0 ? opts.priceUsdc : 0.0001;
  const chainName = chain === "testnet" ? CHAIN_TESTNET.name : CHAIN.name;
  /* One line, or none. Kept as a string rather than a ternary inside the
     template so the trailing comma stays correct in both shapes: a config
     block a developer pastes has to be valid JSON, and "nearly valid" is a
     support question. */
  const apiLine = api ? `        "ACR_API": "${api}",\n` : "";
  /* Free test money is the testnet-only first step to paying; mainnet has no faucet. */
  const faucet =
    chain === "testnet"
      ? `# On ${chainName} the USDC is free: take some from https://faucet.circle.com, deposit it into
# Circle Gateway (the wallet panel on this page does it), then ask can_i_pay.

`
      : "";
  const billQ = opts.bill
    ? `"My agent was billed ${opts.bill.billed} USDC for ${amountOf(opts.bill)}${opts.bill.vendor ? ` by ${opts.bill.vendor}` : ""}. Should it pay?"
#   -> check_spend: the spend agent’s own ten-rung ladder over YOUR invoice, priced against the
#      open market with every quote cited. It says pay, reroute, hold, escalate or refuse, and why.`
    : `"My agent was billed 0.47 USDC for 23 thousand tokens by its inference provider. Should it pay?"
#   -> check_spend: the spend agent’s own ten-rung ladder over YOUR invoice, priced against the
#      open market with every quote cited. This one is ~50x the going rate: it says escalate, names
#      the cheapest model, and how much was avoidable. No account, no key, no history with ACR.`;
  const ledgerQ = opts.remote
    ? ""
    : `

"Has my agent been overpaying its vendors this month?"
#   -> spend_report: every bill check_spend has priced on this machine, totalled. Over the going
#      rate in bp, and what was actually recoverable in USDC. Reads a local file; uploads nothing.`;
  const askBody = `${billQ}

"Can you pay for a metered ACR query right now? If not, what is in the way?"
#   -> can_i_pay: seven rungs — host, chain, card, paywall, challenge, payer key, Gateway funds.
#      Needs no key, and spends nothing: it asks for the 402 and does not answer it.${ledgerQ}

"What did ${payer} overpay ${window}, and where should it buy instead?"
#   -> wallet_tca + reroute_suggestion: slippage vs the benchmark, the seller to leave, the saving
#      in bp. Only for a wallet that bought from ACR: one it has never seen answers seen:false

"Rate seller ${seller} ${window}, and tell me how much of that grade is actually measured."
#   -> seller_rating: it answers Unrated on a thin tape and says so, rather than scoring the
#      missing components zero — which is the part worth seeing

"How many settlements landed on the tape in the last hour, and how many were human-backed?"
#   -> query_tape("settlements"): the subgraph's own rows, benchmarked in the mapping`;
  /* Counted, not typed: the heading said "Five" over six questions. */
  const asked = askBody.split("\n").filter((l) => l.startsWith('"')).length;
  /* The Aomi App reads Arc MAINNET, so only a mainnet wallet belongs in it. */
  const aomiWallet = chain === "mainnet" && opts.wallet ? opts.wallet : EXAMPLES.mainnet.payer;
  const aomiBill = opts.bill
    ? `"I was billed ${opts.bill.billed} USDC for ${amountOf(opts.bill)}. Should I pay?"`
    : `"I was billed 0.47 USDC for 23,000 tokens of inference. Should I pay?"`;
  return {
    config: `{
  "mcpServers": {
    "acr-tca": {
      "command": "npx",
      "args": ["-y", "acr-mcp"],
      "env": {
${apiLine}        "ACR_AGENT_PRIVATE_KEY": "0x<optional: any 32-byte key, the card, not a wallet>",
        "ACR_HUMAN_AGENT_KEY": "0x<optional: a wallet in AgentBook, for wallet_tca(\\"me\\")>"
      }
    }
  }
}`,
    pay: `${faucet}# Add these two and pay_and_read appears. Without them it is not registered at all.
# A metered query is $${price}, so the cap is what stops a loop, not your attention.

{
  "mcpServers": {
    "acr-tca": {
      "command": "npx",
      "args": ["-y", "acr-mcp"],
      "env": {
${apiLine}        "ACR_PAYER_PRIVATE_KEY": "0x<a wallet YOU control, deposited into Circle Gateway>",
        "ACR_MAX_SPEND_USDC": "0.01"
      }
    }
  }
}

# A settlement spends the GATEWAY balance, not the wallet's USDC. can_i_pay says
# "deposit" rather than "ready" when the wallet is funded and the Gateway is not.`,
    ask: `# ${NUMBER_WORDS[asked] ?? asked} things to ask, once the server is in your host's config (${chainName}):

${askBody}`,
    aomi: `# ACR is also an Aomi App: the same reads, answered inside Aomi's own agent.
# Open the chat PINNED to it. Aomi routes a plain chat on its own and did not pick ACR:

${AOMI_CHAT}

# Then ask, for example:

${aomiBill}
#   -> acr_check_bill: the verdict, the cheapest cited seller, and what was avoidable.

"Has wallet ${aomiWallet} been overpaying for compute?"
#   -> acr_wallet_cost: purchases, slippage against the benchmark, a cheaper seller.

"Where is the ACR inference index, and is it fresh?"
#   -> acr_rate: the on-chain print with its age, and the note that it is an index, not a price.

# The App reads Arc mainnet. Nothing in it signs or spends.`,
  };
}

const noSubscribe = () => () => {};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Where each client's setup goes, said outside the code block (JSON has no comments). */
const WHERE: Record<McpClient, { x: string; p: string }> = {
  "claude-ai": {
    x: "In Claude.ai: Settings, Connectors, Add custom connector, then this name and URL. Nothing to install.",
    p: "In Claude.ai, add a custom connector with this name and address. Nothing to install.",
  },
  "claude-code": {
    x: "Run this once in a terminal; the server is then available in every Claude Code session.",
    p: "Run this once in a terminal and Claude Code can ask ACR.",
  },
  cursor: {
    x: "Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).",
    p: "Paste this into Cursor's settings file.",
  },
  vscode: {
    x: "Add to .vscode/mcp.json in your workspace.",
    p: "Paste this into your editor's settings file.",
  },
  npx: {
    x: "The local package, for what a hosted server cannot do: paying with your own key, and a spend ledger on your machine.",
    p: "Run it on your own computer to let it pay, with your own wallet.",
  },
  aomi: {
    x: "ACR as an Aomi App: the same reads inside Aomi's chat, nothing to configure.",
    p: "Ask ACR inside Aomi's chat. Nothing to set up.",
  },
};

export interface McpSnippetProps {
  /** The press the LOCAL package's config pins (see `snippetApi`). */
  api: string | null;
  chain?: ChainKey;
  /** This deployment's public origin, from the request; the URL is built from it. */
  origin?: string | null;
  /** The live price of a metered query. */
  price?: number | null;
  /** The live receipts, for example subjects when the reader has given none. */
  receipts?: MarketReceipt[] | null;
  /** What the hosted server lists, rendered on the server from the same function. */
  hostedTools?: { name: string; description: string }[] | null;
}

export function McpSnippet({ api, chain = "mainnet", origin = null, price = null, receipts = null, hostedTools = null }: McpSnippetProps) {
  const chainName = chain === "testnet" ? CHAIN_TESTNET.name : CHAIN.name;

  /* The visitor's values, shared with the endpoint table below (lib/usePlayground.ts). */
  const [inputs, update] = usePlaygroundInputs();
  const set = <K extends keyof PlaygroundInputs>(k: K, v: PlaygroundInputs[K]) =>
    update({ [k]: v } as Partial<PlaygroundInputs>);

  /* The origin the page was served from. The server knows it; the browser
     confirms it after hydration, so a proxy that rewrote the host cannot hand
     out a URL that points somewhere else. */
  const here = useSyncExternalStore(noSubscribe, () => window.location.origin, () => origin ?? "");
  const url = here ? mcpUrl(here, chain) : "";

  const read = readInputs(inputs);
  const subjects = useMemo(() => liveSubjects(chain, receipts), [chain, receipts]);

  const [view, setView] = useState<View>("setup");
  const [copied, setCopied] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnectionReport | null>(null);
  const [testing, setTesting] = useState(false);
  const [run, setRun] = useState<(ToolRun & { args: Record<string, unknown> }) | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const listed = conn?.ok ? conn.tools : (hostedTools?.map((t) => t.name) ?? [...HOSTED_TOOLS]);
  const describe = (name: string) => hostedTools?.find((t) => t.name === name)?.description ?? name;

  const remote = isRemoteClient(inputs.client);
  const text = snippets(api, chain, {
    wallet: read.wallet,
    seller: read.bill?.vendor || subjects.seller,
    window: read.wallet ? "last month" : subjects.window,
    bill: read.bill,
    priceUsdc: price,
    remote,
  });

  const setupText = remote
    ? url
      ? remoteSetup(inputs.client as Parameters<typeof remoteSetup>[0], url, chain)
      : "…"
    : inputs.client === "npx"
      ? text.config
      : text.aomi;

  const answerText = run
    ? [
        `# ${run.tool}(${JSON.stringify(run.args)})`,
        `# ${run.status || "no answer"} · ${run.ms} ms${run.press ? ` · ${run.press}` : ""}${run.chain ? ` · ${run.chain}` : ""}${run.isError ? " · isError" : ""}`,
        `# ${readingOf(run.tool, run.payload) ?? run.error ?? ""}`,
        "",
        (typeof run.payload === "string" ? run.payload : JSON.stringify(run.payload, null, 2) ?? "").slice(0, 4000),
      ].join("\n")
    : "# Run a tool above. Its answer appears here exactly as your MCP client would receive it.";

  const shown = view === "setup" ? setupText : view === "pay" ? text.pay : view === "ask" ? text.ask : answerText;

  async function copy(what: string, value: string) {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  }

  async function test() {
    if (!url) return;
    setTesting(true);
    try {
      setConn(await testConnection(url));
    } finally {
      setTesting(false);
    }
  }

  async function runIt(tool: HostedTool) {
    if (!url) return;
    const { args } = toolArgs(tool, read, subjects, inputs.unit);
    setRunning(tool);
    try {
      const r = await runTool(url, tool, args);
      setRun({ ...r, args });
      setView("answer");
    } finally {
      setRunning(null);
    }
  }

  const connLine = conn
    ? conn.ok
      ? `✔ ${conn.server?.name} ${conn.server?.version} · ${conn.tools.length} tools · get_rate ${conn.rate ?? "…"} · ${conn.ms} ms${conn.press ? ` · ${conn.press}` : ""}`
      : `✘ stopped at ${conn.stoppedAt}: ${conn.error ?? "no answer"}`
    : null;
  const wrongChain = conn?.chain && conn.chain !== chain ? conn.chain : null;

  const pressShown = conn?.press ?? run?.press ?? null;

  return (
    <section className="section anchor-target" id="mcp">
      <div className="section-head">
        <Ed x="Ask the Tape" p="Ask the receipts" className="label" />
      </div>
      <p className="muted" style={{ fontSize: 13, maxWidth: 68 * 9, marginTop: 0 }}>
        {HOSTED_TOOLS.length}{" "}
        <Ed
          x="read-only tools at one URL any MCP client can add, no install. Put your own agent's wallet and bill in below and run them live; what you see is what your client gets."
          p="questions an AI assistant can ask ACR. Try them below with your own wallet and bill."
        />
      </p>

      {/* WHICH CHAIN, said out loud, and which press actually answered. */}
      <div className="register-row is-stacked" style={{ fontSize: 13 }}>
        <span className="muted">
          <Ed x="chain" p="network" />
        </span>
        <span className="mono">
          {chainName}
          {pressShown ? ` · ${pressShown}` : null}
        </span>
        <span />
      </div>

      <div className="register-row is-stacked" style={{ fontSize: 13 }}>
        <span className="muted">
          <Ed x="MCP server URL" p="address to add" />
        </span>
        <span className="mono" style={{ overflowWrap: "anywhere" }}>
          {url || "…"}
          {connLine ? (
            <>
              <br />
              <span className={conn?.ok && !wrongChain ? "green" : "vermilion"} style={{ fontSize: 12 }}>
                {connLine}
                {wrongChain ? ` · answered for ${wrongChain}` : null}
              </span>
            </>
          ) : null}
        </span>
        <span className="btn-row" style={{ margin: 0 }}>
          <button type="button" className="mini-btn" onClick={() => copy("url", url)} disabled={!url}>
            {copied === "url" ? <Ed x="copied" p="copied" /> : <Ed x="copy" p="copy" />}
          </button>
          <button type="button" className="mini-btn green" onClick={test} disabled={!url || testing}>
            {testing ? <Ed x="testing…" p="checking…" /> : <Ed x="test connection" p="check it works" />}
          </button>
        </span>
      </div>

      <div className="register-row is-stacked" style={{ fontSize: 13 }}>
        <span className="muted">
          <Ed x="your agent's wallet" p="your agent's wallet" />
        </span>
        <span>
          <input
            type="text"
            className="mono"
            aria-label="your agent's wallet address"
            placeholder={`0x… (else ${short(subjects.payer)}, ${subjects.source === "receipts" ? "a recent payer" : "the example"})`}
            value={inputs.wallet}
            spellCheck={false}
            onChange={(e) => set("wallet", e.target.value.trim())}
            style={{ width: "100%", maxWidth: 420 }}
          />
          {read.walletError ? (
            <span className="muted" style={{ display: "block", fontSize: 12, color: "var(--breach)" }}>
              {read.walletError}
            </span>
          ) : null}
        </span>
        <span>
          {inputs.wallet ? null : (
            <button type="button" className="chip" style={{ cursor: "pointer" }} onClick={() => set("wallet", subjects.payer)}>
              <Ed x="use" p="use" /> {short(subjects.payer)}
            </button>
          )}
        </span>
      </div>

      <div className="register-row is-stacked" style={{ fontSize: 13 }}>
        <span className="muted">
          <Ed x="your bill" p="your bill" />
        </span>
        <span className="btn-row" style={{ margin: 0, alignItems: "center" }}>
          <input
            type="text"
            inputMode="decimal"
            aria-label="amount billed in USDC"
            placeholder="0.47"
            value={inputs.billed}
            spellCheck={false}
            onChange={(e) => set("billed", e.target.value)}
            style={{ width: 90 }}
          />
          <span className="muted">
            <Ed x="USDC for" p="dollars for" />
          </span>
          <input
            type="text"
            inputMode="decimal"
            aria-label="quantity bought"
            placeholder="23"
            value={inputs.quantity}
            spellCheck={false}
            onChange={(e) => set("quantity", e.target.value)}
            style={{ width: 80 }}
          />
          <span className="segmented" role="group" aria-label="unit of the bill" style={{ flexWrap: "wrap" }}>
            {UNITS.map((u: Unit) => (
              <button key={u} type="button" className={u === inputs.unit ? "on" : ""} aria-pressed={u === inputs.unit} onClick={() => set("unit", u)}>
                {u}
              </button>
            ))}
          </span>
          <input
            type="text"
            className="mono"
            aria-label="vendor address, optional"
            placeholder="vendor 0x… (optional)"
            value={inputs.vendor}
            spellCheck={false}
            onChange={(e) => set("vendor", e.target.value.trim())}
            style={{ width: 220 }}
          />
          {read.billError ? (
            <span className="muted" style={{ fontSize: 12, color: "var(--breach)" }}>
              {read.billError}
            </span>
          ) : null}
        </span>
        <span />
      </div>

      <div className="register-row is-stacked" style={{ fontSize: 13 }}>
        <span className="muted">
          <Ed x="run a tool" p="try a question" />
        </span>
        <span className="btn-row" style={{ margin: 0 }}>
          {listed
            .filter((name): name is HostedTool => (HOSTED_TOOLS as readonly string[]).includes(name))
            .map((name) => (
              <button
                key={name}
                type="button"
                className={`mini-btn${run?.tool === name && !run.isError ? " green" : ""}`}
                title={describe(name)}
                disabled={!url || running !== null}
                onClick={() => runIt(name)}
              >
                {name}
                {running === name ? " …" : null}
              </button>
            ))}
          <span className="muted" style={{ fontSize: 12 }}>
            {Object.keys(LOCAL_ONLY).join(" · ")} <Ed x="run in the local package only" p="need the local package" />
          </span>
        </span>
        <span className="muted" style={{ fontSize: 12 }}>
          {read.wallet || read.bill ? <Ed x="with your values" p="with your values" /> : <Ed x="with the example" p="with the example" />}
        </span>
      </div>

      <div className="register-row is-stacked" style={{ fontSize: 13 }}>
        <span className="muted">
          <Ed x="your client" p="your app" />
        </span>
        <span className="segmented" role="group" aria-label="your MCP client" style={{ flexWrap: "wrap" }}>
          {CLIENTS.map((c) => (
            <button key={c} type="button" className={c === inputs.client ? "on" : ""} aria-pressed={c === inputs.client} onClick={() => { set("client", c); setView("setup"); }}>
              {CLIENT_LABEL[c]}
            </button>
          ))}
        </span>
        <span />
      </div>

      <div style={{ marginTop: 14, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {(["setup", "pay", "ask", "answer"] as View[]).map((t) => (
          <button key={t} type="button" className={`mini-btn${view === t ? " green" : ""}`} onClick={() => setView(t)} aria-pressed={view === t}>
            {t === "setup" ? (
              <>
                <Ed x="setup" p="setup" /> · {CLIENT_LABEL[inputs.client]}
              </>
            ) : t === "pay" ? (
              <Ed x="let it pay" p="let it pay" />
            ) : t === "ask" ? (
              <Ed x="what to ask" p="questions" />
            ) : (
              <Ed x="answer" p="answer" />
            )}
          </button>
        ))}
      </div>
      {view === "setup" ? (
        <Ed as="p" className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }} x={WHERE[inputs.client].x} p={WHERE[inputs.client].p} />
      ) : null}
      {view === "setup" && inputs.client === "npx" && api === null ? (
        /* OUTSIDE THE CODE BLOCK, because the config is pasted into a JSON
           file and JSON has no comments. */
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: 12.5, margin: "4px 0 0" }}
          x="No ACR_API line below, on purpose. The press this page is reading does not carry /par, and the package already defaults to one where every tool answers."
          p="The config has no address in it on purpose. The tool already knows where to look."
        />
      ) : null}
      <div className="specimen" style={{ marginTop: 8 }}>
        <button type="button" className="copy-btn" onClick={() => copy("code", shown)}>
          {copied === "code" ? <Ed x="copied" p="copied" /> : <Ed x="copy" p="copy" />}
        </button>
        <pre style={{ maxHeight: 360, overflow: "auto", paddingRight: 64 }}>{shown}</pre>
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
        <Ed
          x="Hosted is read-only and keyless: nothing is stored, nothing is paid. The local package (npx -y acr-mcp"
          p="The hosted version only reads. To let it pay, run the local version (npx -y acr-mcp"
        />{" "}
        {ACR_MCP_VERSION}){" "}
        <Ed
          x="adds paying with your own key and a spend ledger on your machine. The repo's mcp/README.md is the long form."
          p="with your own wallet."
        />
      </p>
    </section>
  );
}
