#!/usr/bin/env node
/**
 * Ask the live Morpho venue, both directions, with nothing signed.
 *
 * This is the command `float/sauce/README.md` promises and `make float-sauce`
 * runs: the CLI is installed, and then the pre-flight is actually exercised
 * rather than described. The two amounts are the README's own worked example,
 * so what this prints and what the README shows are the same thing.
 *
 * A pre-flight that only ever says yes proves nothing, so this exits non-zero
 * unless the coverable amount is ACCEPTED and the impossible one is REFUSED
 * with the program's own sentence. One direction is not a test.
 *
 * T13 in `float/src/bin/verify.ts` stays the authoritative check — it sizes
 * both amounts from the sleeve's real position via `valueUsdc`, which needs
 * viem, and keeping `@eco-incorp/sauce` out of `float/package.json` is the
 * whole point of this separate manifest. This one uses fixed amounts so it can
 * run with no dependency but the CLI itself.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "node_modules", ".bin", "sauce");
const prog = join(here, "jit_preflight.sauce.ts");
const deployment = join(here, "..", "deployments", "arc-testnet.json");

if (!existsSync(cli)) {
  console.error("The Sauce CLI is not installed here. Run `make float-sauce`.");
  process.exit(1);
}
if (!existsSync(deployment)) {
  console.error(`No arc-testnet deployment at ${deployment}.`);
  process.exit(1);
}

const d = JSON.parse(readFileSync(deployment, "utf8"));
const rpc = process.env["FLOAT_RPC"] ?? "https://rpc.testnet.arc.io";

/** The README's worked amounts: one the sleeve covers, one it cannot. */
const CASES = [
  { usd: "0.50", units: "500000", want: /The cook succeeds/, why: "comfortably inside the sleeve" },
  { usd: "50.00", units: "50000000", want: /cannot cover this shortfall/, why: "far beyond it" },
];

console.log(`venue  ${d.venue}`);
console.log(`sleeve ${d.sleeve}`);
console.log(`rpc    ${rpc}`);

let wrong = 0;
for (const c of CASES) {
  let out = "";
  try {
    out = execFileSync(cli, [
      "simulate", prog, "--chain", "arc-testnet", "--rpc-url", rpc,
      "--owner", d.deployer, "--args", d.venue, d.sleeve, c.units,
    ], { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // A reverting cook exits non-zero and its reason is the thing we came for,
    // not a failure of the run.
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const ok = c.want.test(out);
  if (!ok) wrong++;
  const line = out.split("\n").find((l) => /The cook /.test(l));
  const verdict = (line ?? out.trim().split("\n")[0] ?? "(no output)").trim();
  console.log(`\nneed $${c.usd} — ${c.why}`);
  console.log(`  ${verdict}`);
  console.log(ok ? "  as expected" : `  UNEXPECTED: wanted /${c.want.source}/`);
}

console.log();
if (wrong > 0) {
  console.log(`${wrong} of ${CASES.length} directions answered wrongly; the pre-flight is not trustworthy.`);
  process.exit(1);
}
console.log("Both directions as expected, at a real block, nothing signed or sent.");
