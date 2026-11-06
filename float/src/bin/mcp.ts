/**
 * Float as tools an agent can actually hold.
 *
 *   {"mcpServers":{"float":{"command":"node","args":["--import","tsx",
 *     "<repo>/float/src/bin/mcp.ts"],"env":{"FLOAT_NET":"arc-testnet"}}}}
 *
 * This is the surface the product is FOR. An agent does not want a treasury, it
 * wants to know whether it can afford the thing it is about to do and then to do
 * it — so the four tools are: how much compute can I buy, is this price fair,
 * pay for it, and what have I spent.
 *
 * THE AGENT NEVER HOLDS A KEY. `float_pay` submits through the executor key held
 * by this process, and all that key can do is ASK: the vault decides, against a
 * policy the agent cannot reach. So a prompt-injected agent calling `float_pay`
 * in a loop against a rigged seller gets a row of on-chain refusals, not a
 * drained treasury. That is the whole argument, and it is why the dangerous tool
 * is safe to expose at all.
 *
 * `float_quote` is READ-ONLY and costs nothing — it runs the same ladder the
 * payment runs, through the vault's own `classify` view. An agent should call it
 * before anything expensive, which is also how a caller discovers that a price
 * is bad without spending gas to find out.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { decodeEventLog, formatUnits, keccak256, parseAbiItem, toHex, type Address, type Hex } from "viem";
import { explorerTx, feeFor, netFromEnv, publicFor, walletFor } from "../chain.ts";
import * as A from "../artifacts.ts";
import { load } from "../deployments.ts";
import { indexIdFor } from "../prices.ts";

const NET = netFromEnv();
const pub = publicFor(NET);
const d = load(NET);
const V = A.FloatVault();
const S = A.FloatPrintStore();
const U = A.MockUSDC();

const RECEIPT = parseAbiItem(
  "event Receipt(uint256 indexed id, bytes32 indexed agentId, address indexed seller, bytes32 index, uint64 printId, uint256 units, uint256 quote, uint256 fair, int256 premiumBps, bool jitFunded, bool guest, bool humanApproved)",
);

const usd = (n: bigint) => Number(formatUnits(n, 6));
const agentId = (name: string) => keccak256(toHex(name));

async function priceOf(model: string) {
  const index = keccak256(toHex(indexIdFor(model)));
  const [priceWad, printId, postedAt, ciBps] = (await pub.readContract({
    address: d.printStore, abi: S.abi, functionName: "latest", args: [index],
  })) as [bigint, bigint, bigint, number];
  return { index, priceWad, printId, postedAt: Number(postedAt), ciBps };
}

function buildReq(agent: string, model: string, index: Hex, units: bigint, quote: bigint, printId: bigint) {
  return {
    agentId: agentId(agent),
    seller: d.seller,
    index,
    units,
    quoteTotal: quote,
    printId,
    nonce: keccak256(toHex(`${agent}:${model}:${Date.now()}:${Math.random()}`)),
  };
}

const server = new Server({ name: "acr-float", version: "0.1.0" }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: "float_runway",
    description:
      "How much compute the treasury can still buy, in tokens rather than dollars. Call this before committing to a long or expensive task: a dollar balance does not tell you what you can afford to DO.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string", description: "agent name, e.g. scout" } },
      required: ["agent"],
    },
  },
  {
    name: "float_quote",
    description:
      "Ask what a purchase SHOULD cost and whether a seller's quote would be allowed. Read-only, costs nothing, and runs the same ladder the payment runs. Always call this before float_pay.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        model: { type: "string", description: "e.g. openai/gpt-4o-mini" },
        units: { type: "number", description: "how many 1k-token bundles" },
        quote_usdc: { type: "number", description: "optional: the seller's asking price, to test it" },
      },
      required: ["agent", "model", "units"],
    },
  },
  {
    name: "float_pay",
    description:
      "Pay for compute out of the treasury. SPENDS MONEY. The vault refuses anything above the fair-price band, over the agent's caps, or to an unapproved seller — and records the refusal on chain. You hold no key; this only asks.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        model: { type: "string" },
        units: { type: "number" },
        quote_usdc: { type: "number", description: "the seller's asking price in USDC" },
      },
      required: ["agent", "model", "units", "quote_usdc"],
    },
  },
  {
    name: "float_receipts",
    description:
      "What has been spent and whether it was fair. Each row carries the quote, the price the vault independently recomputed, and whether the money came out of the yield venue.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "default 10" } },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const a = (req.params.arguments ?? {}) as Record<string, unknown>;
  const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });

  try {
    if (name === "float_runway") {
      const total = (await pub.readContract({
        address: d.vault, abi: V.abi, functionName: "totalValueUsdc",
      })) as bigint;
      const remaining = (await pub.readContract({
        address: d.vault, abi: V.abi, functionName: "remaining", args: [agentId(String(a["agent"]))],
      })) as bigint;
      const count = (await pub.readContract({
        address: d.printStore, abi: S.abi, functionName: "indexCount",
      })) as bigint;

      const models: Record<string, unknown> = {};
      for (let i = 0n; i < count; i += 1n) {
        const idx = (await pub.readContract({
          address: d.printStore, abi: S.abi, functionName: "indexAt", args: [i],
        })) as Hex;
        const nm = (await pub.readContract({
          address: d.printStore, abi: S.abi, functionName: "indexName", args: [idx],
        })) as string;
        const [priceWad] = (await pub.readContract({
          address: d.printStore, abi: S.abi, functionName: "latest", args: [idx],
        })) as [bigint, bigint, bigint, number];
        const perBundle = priceWad / 10n ** 12n;
        models[nm.replace(/^ACR-INF:/, "")] = {
          usd_per_1k_tokens: Number(formatUnits(priceWad, 18)),
          tokens_the_treasury_could_buy: perBundle > 0n ? Number(total / perBundle) * 1000 : null,
        };
      }
      return text({
        treasury_total_usdc: usd(total),
        this_agents_remaining_today_usdc: usd(remaining),
        by_model: models,
        note: "Runway is in tokens on purpose. A dollar figure does not say what you can afford to do.",
      });
    }

    if (name === "float_quote" || name === "float_pay") {
      const agent = String(a["agent"]);
      const model = String(a["model"]);
      const units = BigInt(Math.max(1, Math.round(Number(a["units"]))));
      const p = await priceOf(model);
      if (p.printId === 0n) {
        return text({ error: "no_print_for_model", model, hint: "the keeper has not priced this model" });
      }
      const fair = (p.priceWad * units) / 10n ** 12n;
      const quote =
        a["quote_usdc"] === undefined
          ? fair
          : BigInt(Math.round(Number(a["quote_usdc"]) * 1e6));

      const r = buildReq(agent, model, p.index, units, quote, p.printId);
      const [reason, code, fairOnChain] = (await pub.readContract({
        address: d.vault, abi: V.abi, functionName: "classify", args: [r],
      })) as [string, number, bigint, bigint];

      if (name === "float_quote") {
        return text({
          model,
          units: Number(units),
          acr_fair_price_usdc: usd(fairOnChain > 0n ? fairOnChain : fair),
          your_quote_usdc: usd(quote),
          premium_percent: fair > 0n ? Number(((quote - fair) * 10000n) / fair) / 100 : null,
          would_be: code === 0 ? "paid" : "refused",
          reason: code === 0 ? "inside policy and inside the fair band" : reason,
          print_id: Number(p.printId),
          print_age_seconds: Math.floor(Date.now() / 1000) - p.postedAt,
          provider_spread_bps: p.ciBps,
        });
      }

      if (code !== 0) {
        // Refused BEFORE a transaction: no gas spent to learn a price is bad.
        return text({
          status: "refused",
          reason,
          code,
          acr_fair_price_usdc: usd(fairOnChain),
          your_quote_usdc: usd(quote),
          advice:
            code === 10
              ? "the seller is asking above the ACR fair band — renegotiate or pick another provider"
              : "the policy refused this; a human would have to widen it",
        });
      }

      const executor = walletFor(NET, "executor");
      const hash = await executor.writeContract({
        address: d.vault, abi: V.abi, functionName: "requestSpend", args: [r],
        account: executor.account!, chain: executor.chain, ...feeFor(NET),
      });
      const rc = await pub.waitForTransactionReceipt({ hash });

      let out: Record<string, unknown> = {};
      for (const log of rc.logs) {
        try {
          const ev = decodeEventLog({ abi: V.abi, data: log.data, topics: log.topics });
          if (ev.eventName === "Receipt") {
            const x = ev.args as unknown as { id: bigint; fair: bigint; quote: bigint; jitFunded: boolean };
            out = {
              status: "paid",
              receipt_id: Number(x.id),
              paid_usdc: usd(x.quote),
              acr_fair_price_usdc: usd(x.fair),
              funded_just_in_time_from_the_yield_venue: x.jitFunded,
            };
          }
          if (ev.eventName === "Denied") {
            const x = ev.args as unknown as { reason: string };
            out = { status: "refused", reason: x.reason };
          }
        } catch { /* not ours */ }
      }
      // THE THIRD BRANCH. A Receipt means paid and a Denied means refused, but a
      // transaction can land carrying neither, and this used to return
      // `{tx: "0x…"}` with no `status` field at all. It fails safe in the sense
      // that nothing is reported as paid — and fails badly in the way that
      // matters here, because the caller is an AGENT: a missing field reads as
      // the absence of a problem, so it would carry on as though the compute
      // were bought. An unknown outcome has to say its own name.
      if (out["status"] === undefined) {
        const reverted = rc.status !== "success";
        out = {
          status: reverted ? "failed" : "unknown",
          reason: reverted
            ? "the transaction reverted, so nothing was paid"
            : "the transaction succeeded but the vault emitted neither a Receipt nor a Denied — "
              + "do NOT treat this as payment; open the transaction and check before retrying, "
              + "because a retry of a request the vault already consumed is refused as a replay",
        };
      }
      return text({ ...out, tx: explorerTx(NET, hash) });
    }

    if (name === "float_receipts") {
      const limit = Math.max(1, Math.min(50, Number(a["limit"] ?? 10)));
      const head = await pub.getBlockNumber();
      const from = head > 9_000n ? head - 9_000n : 0n;
      const logs = await pub.getLogs({ address: d.vault, event: RECEIPT, fromBlock: from, toBlock: head });
      const rows = logs.slice(-limit).reverse().map((l) => {
        const x = l.args as unknown as {
          id: bigint; quote: bigint; fair: bigint; units: bigint; printId: bigint;
          jitFunded: boolean; humanApproved: boolean;
        };
        return {
          receipt_id: Number(x.id),
          paid_usdc: usd(x.quote),
          acr_fair_price_usdc: usd(x.fair),
          premium_percent: x.fair > 0n ? Number(((x.quote - x.fair) * 10000n) / x.fair) / 100 : null,
          units: Number(x.units),
          print_id: Number(x.printId),
          funded_just_in_time: x.jitFunded,
          released_by_a_human: x.humanApproved,
          tx: explorerTx(NET, l.transactionHash!),
        };
      });
      const spent = logs.reduce((s, l) => s + ((l.args as { quote?: bigint }).quote ?? 0n), 0n);
      return text({ total_paid_usdc: usd(spent), payments: logs.length, showing: rows.length, receipts: rows });
    }

    return text({ error: "unknown_tool", name });
  } catch (e) {
    const m = (e as Error).message ?? String(e);
    return text({ error: "tool_failed", detail: m.split("\n")[0] });
  }
});

/** Addresses, so an operator can see which chain these tools are pointed at. */
process.stderr.write(
  `acr-float MCP on ${NET} — vault ${d.vault}, store ${d.printStore}, seller ${d.seller}\n`,
);
await server.connect(new StdioServerTransport());
