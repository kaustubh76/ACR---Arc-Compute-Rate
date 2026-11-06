import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* `viem/utils` rather than `viem`: the same `decodeEventLog`, measured at
   393ms to import against 1286ms for the package root, on a suite the whole
   repo runs. */
import { decodeEventLog } from "viem/utils";

import { ERC20_ABI, SLEEVE_ABI, STORE_ABI, VAULT_ABI, VENUE_ABI } from "./floatAbi";

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
  /* THE ONE ABI WITH NO CONTRACT IN THIS REPO TO DRIVE IT OUT OF, so the list
     is pinned by hand instead. The pin is not a formality: it is what stops
     this ABI quietly growing a function nobody decided to call, which is the
     only failure mode a standard-interface ABI has. Four now, each earning its
     place — `balanceOf` for the payment leg of a walk and for what the treasury
     holds of the reserve fund, and `symbol`, `decimals` and `totalSupply` so
     the reserve panel reads the fund that `docs/TAMEION.md` describes rather
     than asserting it. Adding a fifth should mean updating this line on
     purpose. */
  assert.deepEqual(
    ERC20_ABI.filter((e) => e.type === "function").map((e) => e.name),
    ["balanceOf", "symbol", "decimals", "totalSupply"],
  );
  /* The payment leg of a walk. Standard ERC-20, so there is no contract in
     this repo to drive it out of; what matters is that `to` stays indexed, as
     the seller filter depends on it. */
  const transfer = ERC20_ABI.find((e) => e.name === "Transfer" && e.type === "event") as unknown as {
    inputs: Array<{ name: string; indexed: boolean }>;
  };
  assert.ok(transfer, "no Transfer event in ERC20_ABI");
  assert.deepEqual(transfer.inputs.map((i) => i.name), ["from", "to", "value"]);
  assert.equal(transfer.inputs.find((i) => i.name === "to")?.indexed, true);
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

/* --- the venue's Withdraw, decoded from the real log ---------------------

   WHY THIS TEST AND NOT A SHAPE ASSERTION. `readWalk` decodes every receipt log
   inside a `try` and a `catch` that swallows the failure, because a log matching
   none of its ABIs is simply not part of the story. viem's `decodeEventLog`
   validates the topic count against the number of INDEXED inputs and throws
   when they disagree. So an ABI entry with the wrong indexed layout does not
   produce an error anywhere: the log is silently dropped and the venue's leg
   just never appears, on a surface whose whole claim is that it shows the hop.

   The bytes below are the canonical payment's log 29 verbatim, copied from
   `eth_getTransactionReceipt` on tx 0x7f3fa68c…, so this fails if the entry
   drifts from what Morpho actually emits. */

const REAL_VENUE_WITHDRAW = {
  address: "0xaabbef1d3971c710276ed41ec791bbe14cdb8e88",
  topics: [
    "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db",
    "0x000000000000000000000000dbecae19b2a082b51fc4f0df59cbffd1cb12ad14",
    "0x000000000000000000000000b030e7e592eb2d8a989c7cbca01270b957bb4bdc",
    "0x000000000000000000000000dbecae19b2a082b51fc4f0df59cbffd1cb12ad14",
  ],
  data: "0x0000000000000000000000000000000000000000000000000000000000101a120000000000000000000000000000000000000000000000000ea1099925859ce7",
} as const;

test("VENUE_ABI decodes the venue's real Withdraw, with the figures the chain emitted", () => {
  const ev = decodeEventLog({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    abi: VENUE_ABI as any,
    data: REAL_VENUE_WITHDRAW.data,
    topics: REAL_VENUE_WITHDRAW.topics as unknown as [`0x${string}`, ...`0x${string}`[]],
  }) as { eventName: string; args: Record<string, unknown> };

  assert.equal(ev.eventName, "Withdraw");
  /* 1055250 is 1.055250 USDC at six decimals: the whole quote, which is what a
     payment short of its buffer by the whole quote has to pull. */
  assert.equal(ev.args.assets, 1_055_250n);
  assert.equal(ev.args.shares, 1_054_134_341_145_566_439n);

  /* THE ONE-HOP CLAIM, PROVEN RATHER THAN RESTATED. `Sleeves.sol:87` passes the
     treasury as the receiver so the venue pays the vault DIRECTLY and the money
     never rests in our wrapper. The caller and the owner are the sleeve; the
     receiver is not. */
  assert.equal(String(ev.args.receiver).toLowerCase(), "0xb030e7e592eb2d8a989c7cbca01270b957bb4bdc");
  assert.equal(String(ev.args.caller).toLowerCase(), "0xdbecae19b2a082b51fc4f0df59cbffd1cb12ad14");
  assert.equal(String(ev.args.owner).toLowerCase(), "0xdbecae19b2a082b51fc4f0df59cbffd1cb12ad14");
  assert.notEqual(
    String(ev.args.receiver).toLowerCase(),
    String(ev.args.owner).toLowerCase(),
    "the receiver is the treasury and the owner is the sleeve, which is the hop",
  );
});

test("the three ABIs readWalk already held cannot decode that log, which is why it was invisible", () => {
  /* The reason the venue's leg never reached the client: `decodeEventLog`
     matches on topic0, and this one matches no event in any of the ABIs the
     walk was decoding against. Not a bug in the pick, an absence in the ABI. */
  const unmatched = [VAULT_ABI, SLEEVE_ABI, ERC20_ABI].every((abi) => {
    const names = (abi as readonly { type: string; name?: string }[])
      .filter((e) => e.type === "event")
      .map((e) => e.name);
    return !names.includes("Withdraw");
  });
  assert.ok(unmatched, "no pre-existing ABI declares a Withdraw event");
});
