/** Interop check — does our 402 challenge parse the way GatewayClient does?
 *
 * Mirrors the exact selection logic in @circle-fin/x402-batching v3
 * (GatewayClient.pay / supports): decode the base64 PAYMENT-REQUIRED header,
 * read `.accepts`, and match `network === eip155:<chainId>`, `amount`,
 * `extra.name === "GatewayWalletBatched"`, `extra.version === "1"`,
 * `typeof extra.verifyingContract === "string"`. Run against any gate mode:
 *
 *   npm run interop -- [--api http://127.0.0.1:8000] [--chain-id 5042002]
 */

const args = process.argv.slice(2);

/** Value after a flag; undefined when the flag is absent or dangling. */
function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

const api = (flagValue("--api") ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const parsedChainId = Number(flagValue("--chain-id") ?? 5042002);
const chainId = Number.isFinite(parsedChainId) && parsedChainId > 0 ? parsedChainId : 5042002;

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function check(name: string, pass: boolean, detail: string): Check {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return { name, pass, detail };
}

async function run() {
  console.log(`interop check against ${api} (expected network eip155:${chainId})\n`);
  const res = await fetch(`${api}/prints`);
  const checks: Check[] = [];

  checks.push(check("responds 402 unpaid", res.status === 402, `status ${res.status}`));

  const header = res.headers.get("PAYMENT-REQUIRED");
  checks.push(check("PAYMENT-REQUIRED header present", header !== null, ""));

  let accepts: Array<Record<string, unknown>> = [];
  if (header) {
    try {
      const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      checks.push(check("header decodes to {x402Version, accepts[]}",
        typeof decoded.x402Version === "number" && Array.isArray(decoded.accepts) && decoded.accepts.length > 0,
        `x402Version=${decoded.x402Version}, accepts=${decoded.accepts?.length}`));
      accepts = decoded.accepts ?? [];
    } catch (e) {
      checks.push(check("header decodes to {x402Version, accepts[]}", false, String(e)));
    }
  }

  const expectedNetwork = `eip155:${chainId}`;
  const opt = accepts.find((o) => o.network === expectedNetwork) as
    | { amount?: unknown; maxAmountRequired?: unknown; payTo?: unknown; asset?: unknown;
        maxTimeoutSeconds?: unknown; extra?: Record<string, unknown> }
    | undefined;
  checks.push(check(`option for ${expectedNetwork}`, opt !== undefined, ""));

  if (opt) {
    checks.push(check("amount (v2 key) is an atomic string",
      typeof opt.amount === "string" && /^\d+$/.test(opt.amount), `amount=${opt.amount}`));
    checks.push(check("maxAmountRequired (v1 key) matches",
      opt.maxAmountRequired === opt.amount, `maxAmountRequired=${opt.maxAmountRequired}`));
    checks.push(check("payTo is 0x-address-shaped",
      typeof opt.payTo === "string" && opt.payTo.startsWith("0x"), `payTo=${opt.payTo}`));
    checks.push(check("maxTimeoutSeconds is a number",
      typeof opt.maxTimeoutSeconds === "number", `${opt.maxTimeoutSeconds}`));
    const extra = opt.extra ?? {};
    checks.push(check('extra.name === "GatewayWalletBatched"',
      extra.name === "GatewayWalletBatched", `name=${extra.name}`));
    checks.push(check('extra.version === "1"', extra.version === "1", `version=${extra.version}`));
    checks.push(check("extra.verifyingContract is a string address",
      typeof extra.verifyingContract === "string" && (extra.verifyingContract as string).startsWith("0x"),
      `verifyingContract=${extra.verifyingContract}`));
  }

  const body = await res.json().catch(() => null);
  checks.push(check("JSON body mirrors the envelope (other SDKs parse the body)",
    body !== null && Array.isArray(body.accepts), ""));

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  console.error(`interop check failed to run: ${err instanceof Error ? err.message : err}`);
  console.error("is the API up? (make api)");
  process.exit(1);
});
