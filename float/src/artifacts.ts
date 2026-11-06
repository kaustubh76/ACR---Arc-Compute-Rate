/**
 * ABIs and bytecode, read from forge's own output.
 *
 * Deliberately NOT hand-copied into a TypeScript constant. A pasted ABI is a
 * second source of truth that drifts the moment a signature changes, and the
 * failure it produces is the worst kind: the encoder builds a call to a selector
 * that no longer exists, the node reverts without a reason string, and it reads
 * like a chain problem. Reading `contracts/out` means `forge build` is the only
 * place a signature lives, and a stale artifact fails loudly here instead.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Abi, Hex } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
/** float/src → repo root → contracts/out */
const OUT = join(HERE, "..", "..", "contracts", "out");

export type Artifact = { abi: Abi; bytecode: Hex };

function load(file: string, name: string): Artifact {
  const path = join(OUT, file, `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `missing artifact ${name} at ${path} — run \`cd contracts && forge build\` first`,
    );
  }
  const j = JSON.parse(raw) as { abi?: Abi; bytecode?: { object?: string } };
  const object = j.bytecode?.object;
  if (!j.abi || !object) throw new Error(`artifact ${name} has no abi or bytecode`);
  return { abi: j.abi, bytecode: (object.startsWith("0x") ? object : `0x${object}`) as Hex };
}

export const FloatVault = () => load("FloatVault.sol", "FloatVault");
export const FloatPrintStore = () => load("FloatPrintStore.sol", "FloatPrintStore");
export const Erc4626Sleeve = () => load("Sleeves.sol", "Erc4626Sleeve");
export const UsycSleeve = () => load("UsycSleeve.sol", "UsycSleeve");
export const FloatTestSeller = () => load("FloatTestSeller.sol", "FloatTestSeller");

/** Test doubles, used only to stand up a local chain. Never deployed to Arc. */
export const MockUSDC = () => load("MockUSDC.sol", "MockUSDC");
export const MockVault4626 = () => load("Doubles.sol", "MockVault4626");
