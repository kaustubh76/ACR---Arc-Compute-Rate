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
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" },
  },
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

export type Net = "anvil" | "arc-testnet";

export function netFromEnv(): Net {
  const n = process.env["FLOAT_NET"] ?? "anvil";
  if (n !== "anvil" && n !== "arc-testnet") {
    throw new Error(`FLOAT_NET must be anvil or arc-testnet, got ${n}`);
  }
  return n;
}

export function chainFor(net: Net) {
  return net === "anvil" ? anvil : arcTestnet;
}

export function rpcFor(net: Net): string {
  return process.env["FLOAT_RPC"] ?? chainFor(net).rpcUrls.default.http[0]!;
}

export function publicFor(net: Net): PublicClient {
  return createPublicClient({ chain: chainFor(net), transport: http(rpcFor(net)) }) as PublicClient;
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
    transport: http(rpcFor(net)),
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
  return net === "arc-testnet"
    ? { maxFeePerGas: ARC_MIN_FEE_WEI, maxPriorityFeePerGas: 1_000_000_000n }
    : {};
}

export function explorerTx(net: Net, hash: string): string {
  if (net !== "arc-testnet") return hash;
  return `${arcTestnet.blockExplorers.default.url}/tx/${hash}`;
}
