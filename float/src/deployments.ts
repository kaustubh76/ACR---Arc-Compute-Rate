/**
 * Where the deployed addresses live, per network.
 *
 * One file per network under `float/deployments/`, so a local run and a testnet
 * run cannot be confused for each other — which matters more than it sounds:
 * the most expensive mistake available here is reading a receipt from anvil and
 * believing it happened on Arc.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Address } from "viem";
import type { Net } from "./chain.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "deployments");

export type Deployment = {
  net: Net;
  chainId: number;
  usdc: Address;
  venue: Address;
  printStore: Address;
  vault: Address;
  sleeve: Address;
  seller: Address;
  deployer: Address;
  executor: Address;
  keeper: Address;
  approver: Address;
  deployedAt: string;
};

export function pathFor(net: Net): string {
  return join(DIR, `${net}.json`);
}

export function save(d: Deployment): string {
  mkdirSync(DIR, { recursive: true });
  const p = pathFor(d.net);
  writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
  return p;
}

export function load(net: Net): Deployment {
  try {
    return JSON.parse(readFileSync(pathFor(net), "utf8")) as Deployment;
  } catch {
    throw new Error(
      `no deployment for ${net} — run \`npm run local\` (anvil) or the forge deploy script (arc)`,
    );
  }
}
