/** The tool surface, separated from the transport so it can be tested.
 *
 * Every tool is a thin HTTP client over the ACR API. Deliberately: the TCA and
 * rating arithmetic lives in one place (services/index_api), and a plugin that
 * recomputed any of it would be a second implementation to keep in step — and
 * the first time they disagreed, a judge would be looking at two different
 * answers to the same question with no way to tell which was the benchmark.
 *
 * The exception is the paying half (`can_i_pay`, `pay_and_read`): there is no
 * endpoint that can answer "can THIS agent pay" on a caller's behalf, because the
 * answer depends on a key and a balance the server has never seen. That part is
 * assembled here, out of the gate's own descriptors plus two on-chain reads.
 */

import { arcChain } from "./chain.js";
import { append as recordSpend, logPath, read as readSpendLog, report as spendReport } from "./spendLog.js";
import {
  admits,
  fundingStep,
  GatewayPayer,
  newLedger,
  payerAddress,
  priceFromChallenge,
  readBalances,
  record,
  validateKey,
  type SpendLedger,
} from "./pay.js";
import { staleness } from "./printAge.js";
import { canIPay, DEFAULT_GATED_ENDPOINT } from "./preflight.js";

/** The press this plugin reads when nothing says otherwise.
 *
 *  The same host `/developers` renders in its config block, because a developer
 *  who follows the page and one who follows this file must not end up on
 *  different chains. Two things pin it here rather than to the other Arc: the
 *  terminal REFUSES a seller that is not on the build's chain (lib/apiBase.ts),
 *  so the page would not call it anyway; and the terminal has a whole-project
 *  gate forbidding the other network's values in its shipping UI, with eight
 *  recorded incidents behind it (apps/terminal/lib/mainnetOnly.test.ts).
 *
 *  Overriding `ACR_API` to any other press needs NOTHING else changed: the chain
 *  id the card is signed for comes from whichever gate it names, not from here
 *  (see `card.ts:gateChainId`). That was the whole bug. */
export const DEFAULT_API = "https://acr-api-mainnet.onrender.com";

/** The three units a bill can be priced in, and the only three.
 *
 *  `_PRICEABLE_UNITS` in the press, derived there from the index roster
 *  (`spec_for(i).unit for i in ALL_INDEX_IDS`), and the press answers **422** to
 *  anything else — naming this list back in the refusal, which is how a caller
 *  can always recover the current set without reading our source.
 *
 *  SHIPPED WRONG ONCE, so the list is a constant now rather than prose in a
 *  description. The schema used to offer `"$/GPU-hour"` and `"$/GB-month"` as
 *  examples; neither exists, so two of the three units this tool advertised were
 *  an instant 422. An example in a tool description is not documentation — it is
 *  the value a model will actually send. */
export const UNITS = ["$/1k tokens", "$/GPU-sec", "$/MB"] as const;
export type Unit = (typeof UNITS)[number];

/** The lookback a window-taking tool uses when the caller names none.
 *
 *  Was 7, which returned nothing for everything. Measured 2026-10-08: at 7 days
 *  every payer and seller on both presses reported zero rows — including the two
 *  addresses `/developers` prints as its worked examples. At 30 the same payer
 *  has 87 purchases and the same seller grades D. A default that makes the live
 *  system look empty teaches the wrong thing about it. */
export const DEFAULT_DAYS = 30;

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
const DAYS = { type: "number", description: `window in days (default ${DEFAULT_DAYS})` };

export const TOOLS: ToolDef[] = [
  {
    /* NAMED FOR WHAT IT GRADES. This was `my_tca`, and "my" was wrong twice
       over: it never reads the configured ACR_AGENT_PRIVATE_KEY (it grades
       whatever address you type, so pasting someone else's gives you theirs),
       and it can only see wallets that bought from ACR's own sellers — it
       reads settlements mirrored from ACR's x402 paywall. A developer pointing
       `my_tca` at their own agent's wallet got zeros about money ACR never saw.
       `spend_report` is the tool that answers "what is MY agent spending".
       Renamed before the package was ever published, so no host breaks. */
    name: "wallet_tca",
    description:
      "Transaction-cost analysis for a wallet THAT BOUGHT FROM ACR: what its purchases cost " +
      "against the ACR print it could have seen at the moment of each trade. Returns " +
      "volume-weighted slippage in basis points, USDC overpaid, and a per-seller breakdown. " +
      "A wallet that has never bought from an ACR seller comes back `seen: false` — it does " +
      "not report zero cost. For bills you pay your own vendors, use check_spend and " +
      'spend_report. Pass "me" for one figure across every wallet a verified human is ' +
      "resolved to, without naming any of them.",
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
    inputSchema: {
      type: "object",
      // `"me"` works here exactly as it does on wallet_tca, and the schema said
      // ADDRESS — an undocumented capability a model can never discover, which
      // is the same as not having it.
      properties: {
        target: {
          type: "string",
          description: 'an 0x address, or "me" for the calling human\'s own wallets unioned together',
        },
        days: DAYS,
      },
      required: ["target"],
    },
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
      "Price one quote against what the market is actually paying, before you pay it. Give the " +
      "`unit` the quote is denominated in and it goes through ACR's /par benchmark, which " +
      "returns the verdict the spend agent itself would reach. Without a unit it can only " +
      "compare against the index print, which is a different quantity from a per-unit price, so " +
      "it says so and refuses rather than reporting a slippage of two million basis points.",
    inputSchema: {
      type: "object",
      properties: {
        price: { type: "number", description: "the quoted price, USDC" },
        unit: {
          type: "string",
          enum: [...UNITS],
          description:
            `what the price is per — one of ${UNITS.join(" | ")}, and the press 422s anything ` +
            "else. Strongly recommended: the unit is what selects the market to compare against.",
        },
        quantity: { type: "number", description: "how many units the quote covers (default 1)" },
        index_id: {
          type: "string",
          description: "ACR-INF | ACR-GPU | ACR-DATA — only used for the unit-less fallback",
        },
      },
      required: ["price"],
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
        operation: { type: "string", description: "an operation name; omit to list them" },
        variables: { type: "object", description: "that operation's variables" },
      },
    },
  },
  {
    name: "check_spend",
    description:
      "Should you pay this bill. Give it an invoice as the invoice is written — the amount " +
      "billed, how much you bought, and the unit — and it runs ACR's benchmark and the spend " +
      "agent's own decision ladder over it, returning the verdict that agent would reach: pay, " +
      "reroute, hold, escalate or refuse, with the rule that produced it and the published " +
      "prices it was judged against. Works on ANY vendor's bill: it needs no account, no key " +
      "and no history with ACR. Nothing is paid and nothing is signed.",
    inputSchema: {
      type: "object",
      properties: {
        billed_usdc: {
          type: "number",
          description: "the amount on the invoice, USDC — as billed, not per unit",
        },
        quantity: {
          type: "number",
          description:
            "how much you bought, counted IN the unit below — so 23 for 23,000 tokens at " +
            '"$/1k tokens", not 23000. The bill divided by this is the per-unit price compared.',
        },
        unit: {
          type: "string",
          enum: [...UNITS],
          description: `what you were buying — one of ${UNITS.join(" | ")}`,
        },
        vendor: {
          type: "string",
          description:
            "who billed you, as an 0x address. Optional, and it changes the answer: a seller " +
            "ACR operates is judged against ACR's own fleet prices, anyone else against the " +
            "open market, and a vendor is always excluded from its own comparison set.",
        },
      },
      required: ["billed_usdc", "quantity", "unit"],
    },
  },
  {
    name: "spend_report",
    description:
      "The running total of every bill this machine has had checked: how many were over the " +
      "going rate, by how much in basis points, the worst vendor, and — only where a cheaper " +
      "seller was actually reachable — what could have been paid instead in USDC. This is the " +
      "answer to \"is my agent overpaying\" for an agent that pays its own vendors and has " +
      "never touched ACR. Built from a local file on this machine; nothing is uploaded, and " +
      "ACR never sees whether you paid any of these bills.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "window in days, 1 to 365. Default 30.",
        },
        vendor: {
          type: "string",
          description: "narrow to one vendor address, as it was given to check_spend",
        },
      },
    },
  },
  {
    name: "can_i_pay",
    description:
      "Can this agent actually pay for a metered query, and if not, which rung is in the way. " +
      "Checks the host and its chain, whether the gate accepts this agent's card, whether the " +
      "endpoint is really behind the paywall, that the 402 challenge parses, whether a payer key " +
      "is configured, and whether the money is in the Circle Gateway balance a settlement spends " +
      "from. Reads only — it asks for the 402 and does not answer it, so nothing is spent and no " +
      "key is needed to run it.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          description: 'which paid endpoint to check, e.g. "/prints" (the default)',
        },
      },
    },
  },
  {
    name: "pay_and_read",
    description:
      "SPENDS MONEY. Pay for one metered query and return both the data and the settlement " +
      "reference: 402 challenge, EIP-3009 authorization against Circle Gateway, retry, 200. " +
      "Only available when a payer key is configured, and refused past the session's spend cap. " +
      "Run can_i_pay first — it names what would stop this.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          description: 'the paid endpoint to buy, e.g. "/prints" or "/prints/ACR-GPU"',
        },
      },
      required: ["endpoint"],
    },
  },
  {
    name: "payment_receipts",
    description:
      "Did the payment land. The settlement tape plus the revenue counter, narrowed to this " +
      "agent's payer address when one is configured. Counts run SHORT, never long: receipts held " +
      "only in the press's memory are lost if it restarts, while the chain row survives — so " +
      "treat what this returns as a floor, not a total.",
    inputSchema: {
      type: "object",
      properties: {
        payer: {
          type: "string",
          description: "an 0x address to narrow to; defaults to this plugin's own payer",
        },
        limit: { type: "number", description: "how many receipts to return (default 20)" },
      },
    },
  },
];

/** Which tools to advertise to the host.
 *
 *  `pay_and_read` is withheld unless a payer key is configured. A tool a host can
 *  see is a tool a model will try, and "you have no key" is a worse answer than
 *  never offering the capability — while `can_i_pay`, which is read-only, stays
 *  available precisely so the model can explain what is missing. */
export function toolsFor(hasPayerKey: boolean): ToolDef[] {
  return hasPayerKey ? TOOLS : TOOLS.filter((t) => t.name !== "pay_and_read");
}

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

/** How far a quote may sit from the thing it is compared against before the
 *  comparison is more likely a unit mismatch than a bad deal. 100,000 bp is 1000%.
 *
 *  THE NUMBER THIS GUARDS. `benchmark_price({index_id: "ACR-GPU", price: 2.50})`
 *  used to answer `available: true, slippage_bp: 2257157.1` — a confident
 *  22,572% — because the ACR print is a macro index LEVEL, not a dollar price per
 *  unit of anything. A real GPU invoice quotes dollars an hour; ACR prices
 *  `$/GPU-sec`; and the index level is a third quantity again. None of the three
 *  is comparable to the others, and a refusal that says so is worth more than a
 *  number wrong by three orders of magnitude. */
export const UNIT_SANITY_BP = 100_000;

/** Present AND zero. An ABSENT count is not a zero count: the payload simply did
 *  not carry that field, and treating the two alike put a "no rows" hint on
 *  answers that had rows in them. */
function countedZero(v: unknown): boolean {
  return typeof v === "number" && v === 0;
}

/** Add a hint when a window came back empty, so "nothing happened" is
 *  distinguishable from "nothing happened IN THIS WINDOW" — the second is a
 *  question about the argument, and the caller can act on it. */
function withWindowHint(body: unknown, days: number, empty: (b: Record<string, unknown>) => boolean): unknown {
  if (!body || typeof body !== "object") return body;
  const b = body as Record<string, unknown>;
  if (b.available !== true || !empty(b)) return body;
  return {
    ...b,
    hint: `no rows in the last ${days} days. This is the window, not necessarily the whole tape — ` +
      "try a wider `days` before concluding there is no history.",
  };
}

/** Dispatch one tool call. Returns the payload the host will render. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: {
    api?: string;
    fetchImpl?: Fetchish;
    nullifier?: string;
    humanKey?: string;
    /** The developer's own payer key. Absent → `can_i_pay` says so, `pay_and_read` refuses. */
    payerKey?: string;
    /** Per-process spend ceiling and tally; created once in server.ts. */
    ledger?: SpendLedger;
    /** Mints the agent card for the settlement request itself. */
    extraHeaders?: () => Promise<Record<string, string>>;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<unknown> {
  const api = (opts.api ?? DEFAULT_API).replace(/\/$/, "");
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as Fetchish);
  const days = typeof args.days === "number" ? args.days : DEFAULT_DAYS;

  switch (name) {
    case "wallet_tca": {
      const body =
        String(args.target) === "me"
          ? await humanTca(f, api, days, opts.nullifier, opts.humanKey)
          : await readJson(f, `${api}/tca/${String(args.target)}?days=${days}`);
      return withWindowHint(body, days, (b) => countedZero(b.purchases));
    }

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

    case "seller_rating": {
      const body = await readJson(f, `${api}/rating/${String(args.seller)}?days=${days}`);
      return withWindowHint(body, days, (b) => countedZero(b.n));
    }

    case "get_rate": {
      const body = (await readJson(f, `${api}/onchain/${String(args.index_id)}`)) as {
        error?: string;
        body?: { detail?: string };
        posted_at?: number;
        value?: number;
      };
      /* A press with no print is a state, not a transport failure. Say which it
         is, and that the value is still buyable from the paid endpoint.

         THIS BRANCH IS NOT "THE TESTNET BRANCH", whatever it used to say. It
         claimed "this host serves the testnet oracle, which has no posted
         prints" — measured false on 2026-10-10: the testnet press answers
         ACR-INF, ACR-GPU and ACR-DATA with real values, 25 days old. ACR-QUERY
         has no print at all there.
         AND IT IS NOT STABLE EITHER WAY. Within ten minutes the same press
         answered ACR-GPU with a value, then 404, then the value again — Arc
         throttles `eth_getLogs` with a 429 and the press's read path surfaces
         that as "no print". So neither branch is the testnet branch: a 404 here
         may mean "never posted" OR "could not read just now", and the one thing
         this code must not do is turn either into a confident claim about the
         deployment. The staleness block below is what the stale-but-present
         case actually needed. */
      if (body?.error === "HTTP 404") {
        return {
          available: false,
          index_id: args.index_id,
          reason:
            `${api} has no on-chain print for ${String(args.index_id)} ` +
            `(${body.body?.detail ?? "404"}). Its oracle has not been posted to.`,
          try_instead: `pay_and_read("/prints/${String(args.index_id)}") reads the same value from the metered endpoint.`,
        };
      }
      /* HOW OLD THE NUMBER IS, BESIDE THE NUMBER. `posted_at` was already in
         this payload and already ignored, which is how `get_rate("ACR-INF")`
         came to answer 0.4923551190903513 off a print 25.05 days dead with
         nothing said about it. An agent cannot ask a follow-up question; the
         one answer it gets has to carry the caveat. Same judgement the terminal
         reached in c6b1912, for the surface that actually acts on it. */
      if (body && typeof body === "object" && !body.error) {
        return { ...body, ...staleness(body.posted_at, "this print") };
      }
      return body;
    }

    case "benchmark_price": {
      const price = Number(args.price);
      const quantity = typeof args.quantity === "number" && args.quantity > 0 ? args.quantity : 1;
      const unit = String(args.unit ?? "").trim();

      // The real pre-trade surface: /par runs the spend agent's own `decide()`
      // over the bill and hands back the verdict it would reach. Needs the unit,
      // because the unit is what selects the market to compare against.
      if (unit) {
        const q =
          `unit=${encodeURIComponent(unit)}` +
          `&billed_usdc=${encodeURIComponent(String(price * quantity))}` +
          `&quantity=${encodeURIComponent(String(quantity))}`;
        const par = (await readJson(f, `${api}/par?${q}`)) as {
          error?: string;
          body?: unknown;
          basket?: { fetched_at?: number };
        };
        // The same reference, the same age — see `check_spend` below for why.
        if (!par?.error) {
          return { ...par, reference: staleness(par.basket?.fetched_at, "the market basket") };
        }
        if (par.error !== "HTTP 404") {
          return {
            available: false,
            reason: `the benchmark refused this bill: ${par.error}`,
            detail: par.body,
          };
        }
        // 404 means this press predates /par — fall through to the index
        // comparison, which is weaker but honest about being weaker.
      }

      const indexId = String(args.index_id ?? "");
      if (!indexId) {
        return {
          available: false,
          reason:
            "no `unit` was given and this press has no /par, so there is nothing to compare " +
            `against. Pass \`unit\` (${UNITS.join(" | ")}), or \`index_id\` for the weaker ` +
            "index comparison.",
        };
      }
      const print = (await readJson(f, `${api}/onchain/${indexId}`)) as { value?: number };
      const arrival = typeof print?.value === "number" ? print.value : null;
      if (arrival === null || !(arrival > 0)) {
        return {
          available: false,
          index_id: indexId,
          reason: `no on-chain print for ${indexId} on ${api} to compare against.`,
        };
      }
      const slippageBp = Math.round(((price - arrival) / arrival) * 1e4 * 10) / 10;
      if (Math.abs(slippageBp) > UNIT_SANITY_BP) {
        return {
          available: false,
          index_id: indexId,
          quoted: price,
          arrival,
          reason:
            `the quote and the ${indexId} index level are ${Math.abs(slippageBp / 1e4).toFixed(0)}x apart, ` +
            "which means they are not the same quantity — the index is a level, not a dollar price per " +
            "unit. Pass the `unit` this quote is per so the comparison goes through /par instead.",
        };
      }
      return {
        available: true,
        index_id: indexId,
        quoted: price,
        arrival,
        // Same convention the mappings use for a settled purchase, so a quote
        // and a fill are measured the same way.
        slippage_bp: slippageBp,
        basis: "the latest on-chain ACR print",
        caveat: "an index level, not a per-unit market price. Pass `unit` for the /par benchmark.",
      };
    }

    case "query_tape": {
      if (!args.operation) return readJson(f, `${api}/graph/operations`);
      const res = await f(`${api}/graph/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: args.operation, variables: args.variables ?? {} }),
      });
      const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
        detail?: unknown;
      };
      // The agent screen in front of this route fails CLOSED, which is the right
      // default for a screen and an opaque answer for a caller: a developer
      // reading "could not reach a verdict" has no way to tell that it is the
      // press's own credential that is missing and nothing they did. Say so, and
      // name the descriptor that proves it — `screened: 0` with no last
      // invocation means the screen has never once run on that host.
      if (typeof body?.detail === "string" && /agent screen could not reach a verdict/i.test(body.detail)) {
        return {
          available: false,
          operation: args.operation,
          reason:
            `${api} refused this read: ${body.detail}. That is the press's screen failing closed, ` +
            "not a problem with your call or your card.",
          host_side: true,
          check: `GET ${api}/armor/info — "screened": 0 with no last_invocation means the screen has ` +
            "never run there, so every carded read of the tape will be refused until its credential is installed.",
        };
      }
      return body;
    }

    case "check_spend": {
      const billed = Number(args.billed_usdc);
      const quantity = Number(args.quantity);
      const unit = String(args.unit ?? "").trim();
      const vendor = String(args.vendor ?? "").trim();

      // REFUSED HERE, NOT CLAMPED, and the difference matters. A window is
      // clampable because 1..90 are all sensible answers to "how long". A billed
      // amount is not: nudging a typo to the nearest legal value would hand back
      // a verdict about a number nobody entered. Checked locally as well as at
      // the press so the message can name WHICH field was wrong — the press sees
      // them together and answers about both.
      if (!Number.isFinite(billed) || billed <= 0) {
        return { available: false, reason: "billed_usdc must be a number greater than zero." };
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return {
          available: false,
          reason:
            "quantity must be a number greater than zero. Without it there is no per-unit " +
            "price, and a whole bill cannot be compared against a rate.",
        };
      }
      if (!(UNITS as readonly string[]).includes(unit)) {
        return {
          available: false,
          reason: `unit must be one of ${UNITS.join(" | ")}, got ${JSON.stringify(unit)}.`,
          units: [...UNITS],
        };
      }
      if (vendor && !/^0x[0-9a-fA-F]{40}$/.test(vendor)) {
        return {
          available: false,
          reason: `vendor must be a 0x-prefixed 20-byte address, or omitted. Got ${JSON.stringify(vendor)}.`,
        };
      }

      // The bill goes up AS BILLED. The press divides by the quantity itself, so
      // a caller is never asked to do the arithmetic the tool exists to check.
      // `vendor` is omitted entirely rather than sent empty: an absent param is
      // what makes the press substitute its no-vendor sentinel and price the bill
      // against the open market like any other stranger's invoice.
      const q =
        `unit=${encodeURIComponent(unit)}` +
        `&billed_usdc=${encodeURIComponent(String(billed))}` +
        `&quantity=${encodeURIComponent(String(quantity))}` +
        (vendor ? `&vendor=${encodeURIComponent(vendor)}` : "");

      const par = (await readJson(f, `${api}/par?${q}`)) as {
        error?: string;
        body?: { detail?: unknown };
        would?: { intent?: unknown; rule?: unknown };
        over_rate_bp?: number | null;
        verdict?: { verdict?: unknown; saving_usdc?: unknown; best_seller?: unknown };
        par?: { par_usdc?: number | null; best_usdc?: number | null; best_seller?: string | null };
        basket?: { status?: unknown; fetched_at?: number };
      };
      if (!par?.error) {
        /* RECORDED, AND SAID OUT LOUD ON THE SAME BREATH. `recorded_to` rides on
           the answer the developer is already reading, because a README is not
           consent and a tool that quietly starts writing a file of your vendor
           bills to your home directory is a surprise. `null` when
           ACR_SPEND_LOG=off, or when the write failed — never a claimed write
           that did not happen. */
        const recorded_to = recordSpend(
          {
            at: Date.now() / 1000,
            vendor: vendor || null,
            unit,
            quantity,
            billed_usdc: billed,
            over_rate_bp: typeof par.over_rate_bp === "number" ? par.over_rate_bp : null,
            par_usdc: par.par?.par_usdc ?? null,
            best_usdc: par.par?.best_usdc ?? null,
            best_seller: par.par?.best_seller ?? null,
            verdict: typeof par.verdict?.verdict === "string" ? par.verdict.verdict : null,
            // The press's own recoverable figure, not a second computation of
            // it — see `actionable` in spendLog.ts for why that matters.
            saving_usdc:
              typeof par.verdict?.saving_usdc === "number" ? par.verdict.saving_usdc : null,
            intent: typeof par.would?.intent === "string" ? par.would.intent : null,
            basket_status: typeof par.basket?.status === "string" ? par.basket.status : null,
          },
          opts.env,
        );
        /* A VERDICT IS ONLY AS CURRENT AS THE MARKET IT WAS COMPARED AGAINST.
           Measured on the testnet press 2026-10-10: `basket.fetched_at` was
           4.07 days old while this tool returned "over_par, 2500 bp, ESCALATE"
           — a recommendation to act, carrying the age of its own evidence
           unread. Nested under `reference` rather than spread at the top level
           so it cannot be confused with the age of the bill, which is the
           caller's own. */
        return {
          ...par,
          recorded_to,
          reference: staleness(par.basket?.fetched_at, "the market basket"),
        };
      }
      if (par.error === "HTTP 404") {
        return {
          available: false,
          reason:
            `${api} has no /par, so this bill could not be priced. That press predates the ` +
            "benchmark — it is a deployment gap, not a verdict on the bill.",
          host_side: true,
        };
      }
      // A 422 is the press refusing the BILL and it names which field; anything
      // else is the press refusing to answer. Two different things to do next.
      return {
        available: false,
        reason:
          par.error === "HTTP 422"
            ? `the benchmark could not read this bill: ${String(par.body?.detail ?? "422")}`
            : `the benchmark did not answer: ${par.error}`,
        detail: par.body,
        host_side: par.error !== "HTTP 422",
      };
    }

    case "spend_report": {
      /* THE RUNNING ANSWER, and it is computed here rather than asked of the
         press on purpose: these are the developer's own bills and ACR has no
         business holding a copy to do arithmetic it can do locally. */
      const raw = Number(args.days ?? 30);
      const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.trunc(raw))) : 30;
      const path = logPath(opts.env);
      if (!path) {
        return {
          available: false,
          reason:
            "ACR_SPEND_LOG is off, so no bills have been recorded. Unset it (or point it " +
            "at a path) and the next check_spend starts the record.",
        };
      }
      const rows = readSpendLog(opts.env);
      if (rows.length === 0) {
        // NOT an empty report. "No bills yet" and "no bills over the rate" are
        // different facts, and a zeroed report would say the reassuring one.
        return {
          available: false,
          reason: `no bills have been checked yet on this machine (${path}). Run check_spend first.`,
          path,
        };
      }
      const vendor = typeof args.vendor === "string" ? args.vendor : undefined;
      return spendReport(rows, { days, vendor, path });
    }

    case "can_i_pay":
      return canIPay({
        api,
        fetchImpl: f,
        endpoint: typeof args.endpoint === "string" ? args.endpoint : undefined,
        payerKey: opts.payerKey,
        env: opts.env,
      });

    case "pay_and_read": {
      const ledger = opts.ledger ?? newLedger();
      const parsed = validateKey(opts.payerKey ?? "");
      if ("reason" in parsed) {
        return {
          paid: false,
          reason: opts.payerKey
            ? `ACR_PAYER_PRIVATE_KEY is ${parsed.reason}`
            : "no payer key configured, so this plugin cannot pay. Set ACR_PAYER_PRIVATE_KEY to a " +
              "wallet you control. can_i_pay() reports every other rung without one.",
        };
      }
      const endpoint = String(args.endpoint ?? DEFAULT_GATED_ENDPOINT);
      const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

      // The chain comes from the host, never from a literal here — the whole
      // class of bug this plugin shipped with was a chain assumed rather than asked.
      const health = (await readJson(f, `${api}/health`)) as { chain_id?: unknown };
      const chainId = Number(health?.chain_id);
      const chain = Number.isFinite(chainId) ? arcChain(chainId, opts.env) : null;
      if (!chain) {
        return {
          paid: false,
          reason: `${api} reports chain ${String(health?.chain_id ?? "?")}, which this plugin has no ` +
            "payment profile for. Run can_i_pay() for the full ladder.",
        };
      }

      // Price the call BEFORE authorizing anything, so the cap is checked against
      // the real amount rather than an assumed one.
      const probe = (await readJson(f, `${api}${path}`)) as { body?: unknown; error?: string };
      const challenge = probe?.error ? probe.body : probe;
      let price: number;
      try {
        price = priceFromChallenge(challenge);
      } catch {
        return {
          paid: false,
          reason: `${path} did not answer with a priced 402 challenge. Run can_i_pay("${path}") to see why.`,
          gate_said: challenge,
        };
      }
      const allowed = admits(ledger, price);
      if (!allowed.ok) return { paid: false, reason: allowed.reason, price_usdc: price };

      /* ASK WHERE THE MONEY IS BEFORE AUTHORIZING ANYTHING. Without this, a
         short Gateway float is discovered as an exception out of Circle's SDK
         and comes back as `the settlement failed: <raw SDK string>` — which
         does not tell a developer the one thing they need, that an x402
         settlement spends the GATEWAY balance and not the wallet. The sentence
         for that already existed in `preflight.ts`'s funds rung and was
         reachable only by running a second tool. A read, not a send, so it is
         safe on this side of the authorization.
         Unreadable balances are NOT treated as empty: "I could not ask" and
         "it is empty" lead to opposite conclusions, so an unreadable pair falls
         through to the attempt rather than refusing a funded payer. */
      const payerAddr = await payerAddress(parsed.key);
      const bal = await readBalances(chain, payerAddr);
      if (bal.wallet !== null || bal.gateway !== null) {
        const step = fundingStep(bal.wallet ?? 0, bal.gateway ?? 0, price);
        if (step !== "ready") {
          const amounts =
            `wallet ${bal.wallet === null ? "unreadable" : `$${bal.wallet}`}, ` +
            `Gateway ${bal.gateway === null ? "unreadable" : `$${bal.gateway}`}, price $${price}`;
          return {
            paid: false,
            endpoint: path,
            price_usdc: price,
            payer: payerAddr,
            funding_step: step,
            reason:
              step === "deposit"
                ? `${amounts}. An x402 settlement spends the GATEWAY balance, not the wallet: ` +
                  "deposit into Circle Gateway first (Bridge Kit, or the repo's `make circle-deposit`)."
                : `${amounts}. This wallet holds no USDC on ${chain.name} at all — fund it, then ` +
                  "deposit into Circle Gateway.",
            next_step: `can_i_pay("${path}") shows the whole ladder.`,
          };
        }
      }

      try {
        const payer = await GatewayPayer.create(parsed.key, chain, opts.extraHeaders);
        const res = await payer.pay(`${api}${path}`);
        record(ledger, res.paidUsdc);
        return {
          paid: true,
          endpoint: path,
          status: res.status,
          paid_usdc: res.paidUsdc,
          settlement: res.transaction,
          network: res.network,
          payer: res.payer,
          session_spend: { usdc: ledger.spentUsdc, calls: ledger.calls, cap_usdc: ledger.maxUsdc },
          data: res.data,
          verify: `payment_receipts() should now show settlement ${res.transaction}.`,
        };
      } catch (err) {
        return {
          paid: false,
          endpoint: path,
          price_usdc: price,
          reason: `the settlement failed: ${String(err).slice(0, 400)}`,
          next_step: `can_i_pay("${path}") names which rung is in the way.`,
        };
      }
    }

    case "payment_receipts": {
      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 20;
      let mine: string | null = typeof args.payer === "string" ? String(args.payer) : null;
      if (!mine && opts.payerKey) {
        const parsed = validateKey(opts.payerKey);
        if (!("reason" in parsed)) mine = await payerAddress(parsed.key).catch(() => null);
      }
      const [tape, revenue] = await Promise.all([
        readJson(f, `${api}/marketplace/receipts`),
        readJson(f, `${api}/revenue`),
      ]);
      const rows = (((tape as { receipts?: unknown[] })?.receipts ??
        (tape as { settlements?: unknown[] })?.settlements ??
        []) as Array<Record<string, unknown>>).filter((r) =>
        mine ? String(r.payer ?? "").toLowerCase() === mine.toLowerCase() : true,
      );
      const rev = revenue as { paid_queries?: unknown; revenue_usdc?: unknown; recent?: unknown[] };
      const recent = ((rev?.recent ?? []) as Array<Record<string, unknown>>).filter((r) =>
        mine ? String(r.payer ?? "").toLowerCase() === mine.toLowerCase() : true,
      );
      return {
        available: true,
        payer: mine,
        narrowed: mine !== null,
        receipts: rows.slice(0, limit),
        revenue_counter: {
          paid_queries: rev?.paid_queries ?? null,
          revenue_usdc: rev?.revenue_usdc ?? null,
          mine_recent: recent.slice(0, limit),
        },
        caveat:
          "a floor, not a total: receipts the press holds only in memory are lost across a restart, " +
          "while the settlement's chain row survives — so this can run short and never long.",
      };
    }

    default:
      return { error: `unknown tool ${name}`, tools: TOOLS.map((t) => t.name) };
  }
}
