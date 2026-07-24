/** ACR buyer agent — discovers ACR listings and pays per query via x402.
 *
 *   npm run start -- --dev  --count 20                         # offline demo
 *   npm run start -- --live --count 60 --limit 0.01 --discover # Arc testnet
 *
 * Live mode needs AGENT_PRIVATE_KEY in the env (never an argv — it would show
 * in `ps`) and a Gateway balance (see docs/agent-runbook.md).
 */

import { webcrypto } from "node:crypto";
// The Circle Gateway SDK calls a bare `crypto.getRandomValues` (Web Crypto). Under
// tsx/esbuild the global isn't always present in the SDK's module scope, so it
// throws "crypto is not defined" at pay time — polyfill it before that import runs.
if (!globalThis.crypto) (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;

import { AgentConfig, parseArgs } from "./config.js";
import { fetchCatalog, pickResources } from "./catalog.js";
import { DevPayer, FetchLike, GatewayPayer, Payer, PaymentResult, priceFromChallenge } from "./payer.js";
import { printReceipt, printSummary, summarize } from "./receipts.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read the advertised price from a bare 402 WITHOUT paying — so the cap can
 * reject before the first (irrevocable, in live mode) payment. Null when the
 * resource doesn't 402 or the challenge is unreadable. */
async function preflightPrice(url: string, fetchImpl: FetchLike): Promise<number | null> {
  try {
    const res = await fetchImpl(url);
    if (res.status !== 402) return null;
    const body = await res.json().catch(() => ({}));
    return priceFromChallenge(body, res.headers);
  } catch {
    return null;
  }
}

export interface RunDeps {
  payer: Payer;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}

/** The buying loop: round-robin the targets, enforce the spend cap, collect
 * receipts. Exported (with injectable payer/fetch) so tests drive it offline. */
export async function runAgent(cfg: AgentConfig, deps: RunDeps): Promise<PaymentResult[]> {
  const log = deps.log ?? console.log;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let targets: string[];
  if (cfg.discover) {
    const items = await fetchCatalog(cfg.api, fetchImpl);
    targets = pickResources(items, { requireAttested: cfg.requireAttested });
    log(`discovered ${items.length} listings, buying from ${targets.length}`);
    if (cfg.requireAttested && targets.length < items.length) {
      log(`  (skipped ${items.length - targets.length} unattested listings)`);
    }
  } else {
    targets = cfg.paths.map((p) => `${cfg.api}${p}`);
  }
  if (targets.length === 0) throw new Error("nothing to buy (no targets)");

  // Pre-flight: learn the price from a bare 402 before any money moves.
  const advertised = await preflightPrice(targets[0], fetchImpl);
  if (advertised !== null && advertised > cfg.limitUsdc + 1e-12) {
    throw new Error(
      `per-query price $${advertised} exceeds the spend cap $${cfg.limitUsdc} — nothing bought`,
    );
  }

  log(`payer ${deps.payer.address} via ${deps.payer.label}`);
  log(`buying ${cfg.count} queries across ${targets.length} resources (cap $${cfg.limitUsdc})\n`);

  const results: PaymentResult[] = [];
  let spent = 0;
  for (let i = 0; i < cfg.count; i++) {
    const url = targets[i % targets.length];
    // Every settled payment is recorded — real money is never dropped from the
    // books; the cap stops the loop BEFORE the payment that would exceed it.
    const result = await deps.payer.pay(url);
    spent += result.paidUsdc;
    results.push(result);
    printReceipt(results.length, url, result);
    if (i + 1 < cfg.count && spent + result.paidUsdc > cfg.limitUsdc + 1e-12) {
      log(
        `\nspend cap: $${spent.toFixed(6)} spent; the next ~$${result.paidUsdc.toFixed(6)} would exceed $${cfg.limitUsdc} — stopping`,
      );
      break;
    }
    if (cfg.delayMs > 0 && i + 1 < cfg.count) await sleep(cfg.delayMs);
  }
  return results;
}

/** Coerce an operator-pasted key into the exact `0x`+64-hex viem demands.
 *
 * `make buyer-key` can emit a bare 64-hex string (newer hexbytes' `.hex()` drops
 * the `0x`), and a paste may pick up surrounding quotes or a trailing newline.
 * viem's `privateKeyToAccount` rejects all of those with an opaque "invalid
 * private key" — so normalize here and, on real malformation, say what to fix. */
function normalizePrivateKey(raw: string): `0x${string}` {
  let k = raw.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  if (k.startsWith("0x") || k.startsWith("0X")) k = k.slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error(
      `AGENT_PRIVATE_KEY is not a 32-byte hex key (got ${k.length} hex chars after trimming). ` +
        "Export the raw buyer key (the one whose address is 0x870f1F4C…): " +
        "export AGENT_PRIVATE_KEY=0x<64 hex chars>",
    );
  }
  return `0x${k.toLowerCase()}`;
}

async function buildPayer(cfg: AgentConfig): Promise<Payer> {
  if (cfg.mode === "live") {
    const key = process.env.AGENT_PRIVATE_KEY;
    if (!key) {
      throw new Error(
        "live mode needs AGENT_PRIVATE_KEY in the env (a funded EOA — see docs/agent-runbook.md)",
      );
    }
    return GatewayPayer.create(normalizePrivateKey(key));
  }
  // A throwaway payer id per run; the DevFacilitator only checks the format.
  const suffix = `${process.pid}-${Date.now() % 1_000_000}`;
  return new DevPayer(`0xagent-${suffix}`);
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  console.log(`ACR buyer agent — ${cfg.mode} mode against ${cfg.api}`);
  const payer = await buildPayer(cfg);
  const results = await runAgent(cfg, { payer });
  printSummary(summarize(results), payer.label);
  if (results.length === 0) process.exitCode = 1;
}

// Only run when invoked directly (tests import runAgent). pathToFileURL
// handles paths with spaces/percent-encoding (this repo has both).
const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`agent failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
