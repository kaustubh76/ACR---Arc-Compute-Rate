/**
 * Which chain, which keys, and the two Arc facts that silently break clients.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

/**
 * ARC FACT 1 — USDC is the gas token, and it has TWO decimal views of one
 * balance: 18 as the native currency, 6 on the ERC-20 view at 0x3600…0000.
 * `nativeCurrency.decimals` below is 18 because that is the gas view; every
 * AMOUNT this codebase handles is the 6-decimal one. Mixing them is a 1e12
 * error, which `apps/terminal/lib/walletPayer.ts` also carries a warning about.
 */
/**
 * Multicall3, at the address it has on every chain that has one. CHECKED, not
 * assumed: `eth_getCode` returns code on Arc Testnet, and an `aggregate3` of
 * the venue's `totalAssets()` returns 104539024487 — the same answer the direct
 * call gives. A canonical address with nothing behind it would otherwise turn
 * every batched read into a silent empty result.
 */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" },
  },
  contracts: { multicall3: { address: MULTICALL3 } },
});

/**
 * A local fork of Arc Testnet.
 *
 * Deliberately its OWN network rather than a flag on the other two. A fork is
 * neither a local chain nor Arc, and the most expensive mistake available here
 * is reading a receipt from one and believing it happened on the other — so it
 * gets a distinct name and a distinct `deployments/arc-fork.json`, and the real
 * `arc-testnet.json` can never be overwritten by a rehearsal.
 *
 * It keeps Arc's chain id and Arc's fee floor on purpose: the point of
 * rehearsing here is to behave exactly like the thing we are about to spend
 * real money on, including the 20 Gwei mempool floor.
 *
 *   anvil --fork-url https://rpc.testnet.arc.io --port 8547
 */
export const arcFork = defineChain({
  id: 5042002,
  name: "Arc Testnet (local fork)",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8547"] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

/** Arc's ERC-20 view of USDC. Same address on mainnet and testnet. */
export const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;

/** Morpho Vault V2 on Arc Testnet, via Circle's Earn Kit. */
export const ARC_TESTNET_VENUE = "0xAabbeF1D3971c710276ed41eC791BbE14CdB8E88" as const;

/**
 * ARC FACT 2 — a transaction whose `maxFeePerGas` is below 20 Gwei is SILENTLY
 * DROPPED by Arc's mempool. No receipt, no error, no revert: the send succeeds
 * and the transaction never appears. Every wallet client built for Arc pins a
 * floor above it, because the alternative is an hour spent debugging a hang
 * that has no error message anywhere.
 */
export const ARC_MIN_FEE_WEI = 25_000_000_000n; // 25 Gwei, comfortably over the 20 floor

/**
 * `scout` and `waster` have keys so their EOAs are real addresses a judge can
 * open on the explorer — but nothing ever signs with them. Their whole job is
 * to hold zero.
 */
export type Role = "deployer" | "executor" | "keeper" | "scout" | "waster";

/**
 * Read a key from the gitignored `data/` directory.
 *
 * Keys live in files, never in `.env` and never in a terminal. `data/` is
 * gitignored and these are 0600. The address files beside them are what gets
 * shared; the key files are what never leaves the machine.
 */
export function keyFor(role: Role): Hex {
  const path = join(REPO, "data", `float-${role}-key.txt`);
  try {
    const k = readFileSync(path, "utf8").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("not a 32-byte hex key");
    return k as Hex;
  } catch (e) {
    throw new Error(`cannot read ${role} key from ${path}: ${(e as Error).message}`);
  }
}

export function addressFor(role: Role): string {
  return readFileSync(join(REPO, "data", `float-${role}-address.txt`), "utf8").trim();
}

export type Net = "anvil" | "arc-testnet" | "arc-fork";

export function netFromEnv(): Net {
  const n = process.env["FLOAT_NET"] ?? "anvil";
  if (n !== "anvil" && n !== "arc-testnet" && n !== "arc-fork") {
    throw new Error(`FLOAT_NET must be anvil, arc-fork or arc-testnet, got ${n}`);
  }
  return n;
}

export function chainFor(net: Net) {
  if (net === "anvil") return anvil;
  if (net === "arc-fork") return arcFork;
  return arcTestnet;
}

export function rpcFor(net: Net): string {
  return process.env["FLOAT_RPC"] ?? chainFor(net).rpcUrls.default.http[0]!;
}

/** Arc answers a rate limit in words, so match on them. */
const RATE_LIMITED = /rate limit|exceeds defined limit|429|too many requests/i;

const napms = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ARC FACT 3 — Arc counts REQUESTS, and it will refuse you.
 *
 * `Request exceeds defined limit. rate limit exceeded` arrived often enough to
 * kill three acceptance runs in a row, at 10/13, 2/13 and 0/13. We were asking
 * for it: every client here was a bare `http(url)`, one HTTP request per read,
 * against an endpoint shared with a second session on the same address.
 *
 * Three things, in the one place every Node-side client is built:
 *
 *   - `batch: true` — Arc accepts JSON-RPC batches (checked: three calls in one
 *     POST, all answered), so concurrent reads cost one request instead of N.
 *   - `batch: { multicall: true }` on the client, with `multicall3` declared on
 *     the chain, so concurrent `readContract`s collapse into a single
 *     `eth_call`.
 *   - A retry that fires ONLY on a rate limit. A revert is an answer; retrying
 *     it four times just makes a failure slower, which is the mistake the
 *     pages' naive `retry()` makes.
 *
 * The message test covers both shapes this can arrive in — an HTTP 429 and a
 * JSON-RPC error inside a 200 — so it works without having to provoke the
 * limiter to find out which one Arc uses.
 */
/**
 * HTTP POSTs actually sent, which is what Arc counts.
 *
 * Counted here rather than at `request`, because batching is the whole point:
 * one POST can carry twenty calls, so counting calls would report no
 * improvement from the change that made the difference. `FLOAT_RPC_DEBUG=1`
 * prints it, so "an order of magnitude fewer requests" is a number somebody
 * measured and not a claim in a commit message.
 */
let httpPosts = 0;
export const rpcPostCount = () => httpPosts;
if (process.env["FLOAT_RPC_DEBUG"]) {
  process.on("exit", () => console.log(`[rpc] ${httpPosts} HTTP POSTs to the node`));
}

function arcHttp(url: string): Transport {
  const inner = http(url, {
    batch: true,
    retryCount: 2,
    retryDelay: 300,
    timeout: 30_000,
    onFetchRequest: () => { httpPosts++; },
  });
  return ((config: never) => {
    const t = inner(config);
    const base = t.request;
    const request = async (...args: Parameters<typeof base>) => {
      let last: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await base(...args);
        } catch (e) {
          const err = e as { shortMessage?: string; details?: string; message?: string };
          const text = `${err.shortMessage ?? ""} ${err.details ?? ""} ${err.message ?? String(e)}`;
          if (!RATE_LIMITED.test(text)) throw e;
          last = e;
          await napms(500 * 2 ** attempt); // 0.5s, 1, 2, 4, 8
        }
      }
      throw last;
    };
    return { ...t, request };
  }) as Transport;
}

export function publicFor(net: Net): PublicClient {
  return createPublicClient({
    chain: chainFor(net),
    batch: { multicall: true },
    transport: arcHttp(rpcFor(net)),
  }) as PublicClient;
}

/**
 * A wallet for one role.
 *
 * On anvil the first prefunded account is used when no key file exists, so a
 * local run needs no setup. On Arc the key file is required — a local default
 * key on a real chain is how you discover you deployed from the wrong address.
 */
export function walletFor(net: Net, role: Role): WalletClient {
  const key =
    net === "anvil" && !hasKey(role)
      ? ("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex)
      : keyFor(role);
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain: chainFor(net),
    transport: arcHttp(rpcFor(net)),
  });
}

function hasKey(role: Role): boolean {
  try {
    keyFor(role);
    return true;
  } catch {
    return false;
  }
}

/** Fee overrides. Arc needs the floor; anvil must not be given one. */
export function feeFor(net: Net) {
  // The fork inherits Arc's base fee, so it needs the same floor — and wants it,
  // since rehearsing without it would not rehearse the thing that bites.
  return net === "arc-testnet" || net === "arc-fork"
    ? { maxFeePerGas: ARC_MIN_FEE_WEI, maxPriorityFeePerGas: 1_000_000_000n }
    : {};
}

export function explorerTx(net: Net, hash: string): string {
  // A fork's hashes are not on the explorer, and linking them there would be a
  // link to nothing — or worse, to a different transaction.
  if (net !== "arc-testnet") return hash;
  return `${arcTestnet.blockExplorers.default.url}/tx/${hash}`;
}
