import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/* The whole-project gate on WHICH CHAIN the UI talks about.

   Guarantee under test: no Arc testnet value is reachable from the shipping
   terminal — in code or in the bundle it renders on a cold start — now or in any
   future PR. Same two mechanisms as lib/coverage.test.ts: a scan, and a LEDGER
   that must stay exactly as large as it needs to be.

   Why a gate rather than an audit. Between 2026-09-28 and 10-01 this project
   found EIGHT separate places where state outlived the chain switch: a revenue
   counter rehydrating testnet settlements, a venue capture carried across
   networks, hedger receipts, a merged buyer capture, every scheduled workflow,
   the README's own badge, a resumed testnet seller the terminal happily used,
   and /tca answering from whatever subgraph it was pointed at. Every one got in
   because nothing was watching, and each was found by hand, late, in production.
   A hand audit is true for a day. */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** The values that mean "Arc testnet". `Arc Testnet` is the display name, so it
 *  catches copy a reader would actually see. */
const TESTNET = [
  "5042002",
  "rpc.testnet",
  "testnet.arcscan",
  "gateway-api-testnet",
  "acr-api-1fto",
  "ARC-TESTNET",
  "Arc_Testnet",
  "Arc Testnet",
  // The SDK's testnet chain key. Added because the ledger's unused-entry check
  // flagged gatewayBuyer.ts on this gate's first run: the file names `arcTestnet`
  // and nothing here matched it, so a shipping file hardcoding
  // `gatewayChain: "arcTestnet"` — the key a Gateway payment actually travels on
  // — would have passed. The ledger improving the scan is the ledger working.
  "arcTestnet",
];

/* Deliberate, each with the reason it is deliberate. Adding to this map is a
   conscious act that leaves an argument behind; it is not a suppression. The
   unused-entry assertion below is what stops it becoming a dumping ground. */
/* Twice on its first day this map shrank rather than grew: `arcTestnet` was missing
   from the scan, and Colophon.tsx stopped needing an entry once its stale comment was
   rewritten. A ledger that only ever grows is a list of excuses. */
const ALLOWED: Record<string, string> = {
  "lib/chain.ts":
    "the CHAIN_TESTNET profile and the PUBLIC_RPC map row — moving the default to " +
    "mainnet must not delete the network this was proven on, and both are addressed " +
    "explicitly rather than reached by fallback",
  "lib/bridge.ts":
    "branches on f.chainId to pick Sepolia sources for a testnet reader; a branch on " +
    "the live chain is the opposite of a stale default",
  "lib/apiBase.ts":
    "the comment recording WHY chainMismatch() exists — a resumed testnet seller " +
    "answering 200 served chain-5042002 data under a mainnet UI",
  "lib/gatewayBuyer.ts":
    "a doc comment naming the SDK's two possible chain keys (arcTestnet, arc)",
};

function shippingFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...shippingFiles(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = ["app", "components", "lib"].flatMap((d) => shippingFiles(join(ROOT, d)));

/** Which banned values a file contains. */
function hits(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return TESTNET.filter((t) => text.includes(t));
}

test("no Arc testnet value is reachable from the shipping UI", () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    const rel = relative(ROOT, file);
    const found = hits(file);
    if (found.length && !ALLOWED[rel]) {
      offenders.push(`${rel} contains ${found.join(", ")}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a testnet value reached the shipping UI. If it is deliberate, add the file to " +
      "ALLOWED with the reason:\n  " + offenders.join("\n  "),
  );
});

test("the ledger carries no entry it does not need", () => {
  /* The half that keeps a ledger honest. An entry that stops being needed would
     otherwise sit there protecting the next regression in that file — which is
     exactly how `verify_claims` once measured a COLLECTED count and so could not
     see a red suite. */
  const unused = Object.keys(ALLOWED).filter((rel) => {
    const full = join(ROOT, rel);
    try {
      return hits(full).length === 0;
    } catch {
      return true; // the file is gone; the entry outlived it
    }
  });
  assert.deepEqual(unused, [], `ALLOWED entries no longer needed — delete them: ${unused.join(", ")}`);
});

test("the bundle the UI renders offline is mainnet, address by address", () => {
  /* fallback.json is what a visitor sees while the free-tier press wakes, and it
     carried eleven testnet venue fills under a mainnet header as recently as
     2026-09-28. Checked by CONTENT, because a presence test passes on a bundle
     full of another chain's data. */
  const bundle = readFileSync(join(ROOT, "lib", "fallback.json"), "utf8");
  for (const t of TESTNET) {
    assert.ok(!bundle.includes(t), `fallback.json contains ${t} — re-run make snapshot against mainnet`);
  }
  const chain = JSON.parse(bundle).chain ?? {};
  assert.equal(Number(chain.chain_id), 5042);
  assert.equal(chain.caip2, "eip155:5042");
  assert.equal(chain.gateway_chain, "arc");
  assert.equal(chain.circle_blockchain, "ARC");
  assert.ok(String(chain.explorer_base).includes("explorer.arc.io"), chain.explorer_base);
  // The Gateway wallet differs per network and is the one a wallet actually pays.
  assert.equal(chain.gateway_wallet, "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE");
});
