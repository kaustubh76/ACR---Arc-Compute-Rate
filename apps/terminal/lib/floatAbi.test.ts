import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ERC20_ABI, SLEEVE_ABI, STORE_ABI, VAULT_ABI } from "./floatAbi";

/* The read ABIs, driven out of the contracts that own them.

   `policy` and `agentOf` are struct getters: Solidity returns their fields as a
   positional tuple, so `lib/floatOnchain.ts` reads them by index. That is the
   one shape where a change on the chain side is invisible here — insert a field
   into the Policy struct and every number after it shifts, silently, into
   another number's meaning. A buffer rendered as a premium band is not a crash;
   it is a plausible wrong screen.

   So these tests do not compare the ABI against itself. They parse the struct
   declarations out of FloatVault.sol and assert our tuple order IS that order. */

const HERE = dirname(fileURLToPath(import.meta.url));
const FLOAT_SRC = join(HERE, "..", "..", "..", "contracts", "src", "float");
const VAULT_SOL = join(FLOAT_SRC, "FloatVault.sol");
const STORE_SOL = join(FLOAT_SRC, "FloatPrintStore.sol");
const SLEEVES_SOL = join(FLOAT_SRC, "Sleeves.sol");

/** The field names of a `struct X { … }` declaration, in declaration order. */
function structFields(src: string, name: string): string[] {
  const m = src.match(new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `no struct ${name} in the contract`);
  return [...m[1].matchAll(/^\s*[A-Za-z0-9_]+(?:\s*\[\s*\]|\s+)\s*([A-Za-z_][A-Za-z0-9_]*)\s*;/gm)].map((f) => f[1]);
}

/** The named outputs of one of our ABI entries, in order. */
function outputsOf(abi: readonly unknown[], name: string): string[] {
  const e = abi.find((x) => (x as { name?: string }).name === name) as
    | { outputs?: Array<{ name?: string }> }
    | undefined;
  assert.ok(e, `our ABI carries no ${name}`);
  return (e.outputs ?? []).map((o) => o.name ?? "");
}

test("the policy tuple is the Policy struct, in the contract's own order", () => {
  assert.ok(existsSync(VAULT_SOL), `cannot read ${VAULT_SOL}`);
  const src = readFileSync(VAULT_SOL, "utf8");
  assert.deepEqual(outputsOf(VAULT_ABI, "policy"), structFields(src, "Policy"));
});

test("the agentOf tuple is the Agent struct, minus the fields the view drops", () => {
  const src = readFileSync(VAULT_SOL, "utf8");
  const ours = outputsOf(VAULT_ABI, "agentOf");
  const declared = structFields(src, "Agent");

  /* `agentOf` is a hand-written view, not the struct's generated getter: it
     reorders `perRequestUsdc` ahead of the period fields and omits
     `periodLength`. So the assertion is not equality with the struct — it is
     that every name we read is a real field, and that the view's own signature
     in the source is the order we use. */
  for (const name of ours) {
    assert.ok(declared.includes(name), `agentOf returns ${name}, which Agent does not declare`);
  }
  const sig = src.match(/function\s+agentOf\s*\([^)]*\)[\s\S]*?returns\s*\(([\s\S]*?)\)/);
  assert.ok(sig, "no agentOf signature in the contract");
  const fromSource = [...sig[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|$)/g)]
    .map((m) => m[1])
    .filter((n) => !["bool", "uint256", "uint64", "address", "bytes32", "string", "uint8"].includes(n));
  assert.deepEqual(ours, fromSource);
});

test("the SpendReq tuple classify takes is the SpendReq struct, in order", () => {
  const src = readFileSync(VAULT_SOL, "utf8");
  const entry = VAULT_ABI.find((x) => x.name === "classify") as unknown as {
    inputs: Array<{ components?: Array<{ name: string }> }>;
  };
  const ours = (entry.inputs[0].components ?? []).map((c) => c.name);
  assert.deepEqual(ours, structFields(src, "SpendReq"));
});

test("classify returns the four values the ladder reads, in the contract's order", () => {
  const src = readFileSync(VAULT_SOL, "utf8");
  const sig = src.match(/function\s+classify\s*\([^)]*\)[\s\S]*?returns\s*\(([\s\S]*?)\)/);
  assert.ok(sig, "no classify signature in the contract");
  /* The contract names them (reason, code, fairUsdc, printId); we rename the
     last to `pid` so one ABI entry does not carry two `printId`s. Order is what
     this pins. */
  assert.deepEqual(outputsOf(VAULT_ABI, "classify").slice(0, 3), ["reason", "code", "fairUsdc"]);
  assert.match(sig[1], /string\s+(?:memory\s+)?reason[\s\S]*uint8\s+code[\s\S]*uint256\s+fairUsdc[\s\S]*uint64\s+printId/);
});

test("the print store's latest tuple is the order the store declares", () => {
  assert.ok(existsSync(STORE_SOL), `cannot read ${STORE_SOL}`);
  const src = readFileSync(STORE_SOL, "utf8");
  const sig = src.match(/function\s+latest\s*\([^)]*\)[\s\S]*?returns\s*\(([\s\S]*?)\)/);
  assert.ok(sig, "no latest signature in the print store");
  assert.deepEqual(outputsOf(STORE_ABI, "latest"), ["priceWad", "printId", "postedAt", "ciBps"]);
  assert.match(sig[1], /uint256\s+priceWad[\s\S]*uint64\s+printId[\s\S]*uint64\s+postedAt[\s\S]*uint32\s+ciBps/);
});

test("every function we call exists on the contract we call it on", () => {
  const vault = readFileSync(VAULT_SOL, "utf8");
  const store = readFileSync(STORE_SOL, "utf8");
  const sleeves = readFileSync(SLEEVES_SOL, "utf8");

  /* A public state variable has no `function` keyword, so the check is for the
     name followed by a paren OR a public declaration of it. Catches a typo and
     a renamed getter, which is the whole job. */
  const declares = (src: string, name: string) =>
    new RegExp(`function\\s+${name}\\s*\\(`).test(src) ||
    new RegExp(`public\\s+(?:constant\\s+)?${name}\\b`).test(src) ||
    new RegExp(`\\b${name}\\s*;`).test(src);

  for (const e of VAULT_ABI) {
    assert.ok(declares(vault, e.name), `FloatVault does not declare ${e.name}`);
  }
  for (const e of STORE_ABI) {
    assert.ok(declares(store, e.name), `FloatPrintStore does not declare ${e.name}`);
  }
  for (const e of SLEEVE_ABI) {
    assert.ok(declares(sleeves, e.name), `Sleeves does not declare ${e.name}`);
  }
  assert.deepEqual(
    ERC20_ABI.map((e) => e.name),
    ["balanceOf"],
  );
});
