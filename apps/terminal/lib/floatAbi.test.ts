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

  /* Functions only. The ABI now also carries the two tape events, and an
     event is not declared with the `function` keyword. */
  for (const e of VAULT_ABI.filter((x) => x.type === "function")) {
    assert.ok(declares(vault, e.name), `FloatVault does not declare ${e.name}`);
  }
  for (const e of STORE_ABI.filter((x) => x.type === "function")) {
    assert.ok(declares(store, e.name), `FloatPrintStore does not declare ${e.name}`);
  }
  for (const e of SLEEVE_ABI.filter((x) => x.type === "function")) {
    assert.ok(declares(sleeves, e.name), `Sleeves does not declare ${e.name}`);
  }
  assert.deepEqual(
    ERC20_ABI.map((e) => e.name),
    ["balanceOf"],
  );
});

test("the two tape events are the structs the contract emits, field for field", () => {
  const src = readFileSync(VAULT_SOL, "utf8");

  /** The field names of an `event X(...)` declaration, in order. */
  const eventFields = (name: string): string[] => {
    const m = src.match(new RegExp("event\\s+" + name + "\\s*\\(([^)]*)\\)"));
    assert.ok(m, `no event ${name} in the contract`);
    return m[1]
      .split(",")
      .map((f) => {
        const words = f.trim().split(/\s+/).filter((w) => w !== "indexed");
        return words[words.length - 1] ?? "";
      })
      .filter((f) => f.length > 0);
  };

  const ours = (name: string) => {
    const e = VAULT_ABI.find((x) => x.name === name && x.type === "event") as
      | { inputs: Array<{ name: string }> }
      | undefined;
    assert.ok(e, `our ABI carries no ${name} event`);
    return e.inputs.map((i) => i.name);
  };

  assert.deepEqual(ours("Receipt"), eventFields("Receipt"));
  assert.deepEqual(ours("Denied"), eventFields("Denied"));
});

test("premiumBps is read as signed, because a quote below fair is legal", () => {
  const src = readFileSync(VAULT_SOL, "utf8");
  /* An unsigned read of a negative premium renders a bargain as an enormous
     overcharge, and the contract's own type is the only thing that says which
     this is. */
  assert.match(src, /int256\s+premiumBps/);
  const e = VAULT_ABI.find((x) => x.name === "Receipt" && x.type === "event") as unknown as {
    inputs: Array<{ name: string; type: string }>;
  };
  assert.equal(e.inputs.find((i) => i.name === "premiumBps")?.type, "int256");
});

test("the sleeve's cash events are the ones Sleeves.sol emits, field for field", () => {
  const src = readFileSync(join(FLOAT_SRC, "Sleeves.sol"), "utf8");

  const eventFields = (name: string): string[] => {
    const m = src.match(new RegExp("event\\s+" + name + "\\s*\\(([^)]*)\\)"));
    assert.ok(m, `no event ${name} in Sleeves.sol`);
    return m[1]
      .split(",")
      .map((f) => {
        const words = f.trim().split(/\s+/).filter((w) => w !== "indexed");
        return words[words.length - 1] ?? "";
      })
      .filter(Boolean);
  };

  const ours = (name: string) => {
    const e = SLEEVE_ABI.find((x) => x.name === name && x.type === "event") as
      | { inputs: Array<{ name: string; indexed?: boolean }> }
      | undefined;
    assert.ok(e, `our SLEEVE_ABI carries no ${name} event`);
    return e.inputs;
  };

  assert.deepEqual(ours("Parked").map((i) => i.name), eventFields("Parked"));
  assert.deepEqual(ours("Pulled").map((i) => i.name), eventFields("Pulled"));

  /* Non-indexed is load-bearing: it is why the query must carry the sleeve's
     address. If either ever gained an index the filter would have to change. */
  for (const n of ["Parked", "Pulled"]) {
    for (const i of ours(n)) assert.equal(i.indexed, false, `${n}.${i.name} is indexed on our side`);
  }
  assert.doesNotMatch(src, /event\s+Parked\s*\([^)]*indexed/);
  assert.doesNotMatch(src, /event\s+Pulled\s*\([^)]*indexed/);
});

test("the cost basis uses what was DELIVERED, not what was requested", () => {
  /* `withdrawExact` measures the treasury's balance before and after and emits
     the difference as the second field. Using the first would count money that
     never arrived, which is the whole reason the contract emits both. */
  const src = readFileSync(join(FLOAT_SRC, "Sleeves.sol"), "utf8");
  assert.match(src, /emit\s+Pulled\(usdcAmount,\s*usdc\.balanceOf\(treasury\)\s*-\s*before\)/);
  const pulled = SLEEVE_ABI.find((x) => x.name === "Pulled" && x.type === "event") as unknown as {
    inputs: Array<{ name: string }>;
  };
  assert.equal(pulled.inputs[1].name, "usdcDelivered");
});
