import assert from "node:assert/strict";
import { test } from "node:test";

import { DevPayer, priceFromChallenge } from "./payer.js";
import { runAgent } from "./main.js";
import { DEFAULTS } from "./config.js";

const CHALLENGE_BODY = {
  x402Version: 1,
  error: "payment required",
  accepts: [{ scheme: "exact", network: "eip155:5042002", amount: "100", maxAmountRequired: "100" }],
};

function confirmationHeader(tx: string): string {
  return Buffer.from(
    JSON.stringify({ success: true, transaction: tx, network: "arc-testnet", payer: "0xagent-test" }),
  ).toString("base64");
}

/** A stub API: 402 (advertising `price`) without the header, 200 + receipt
 * with it — the challenge body and the enforcement agree, like the real gate. */
function stubFetch(opts: { price?: string } = {}) {
  const price = Number(opts.price ?? "0.0001");
  const atomic = String(Math.round(price * 1e6));
  const challenge = {
    x402Version: 1,
    error: "payment required",
    accepts: [
      { scheme: "exact", network: "eip155:5042002", amount: atomic, maxAmountRequired: atomic },
    ],
  };
  let settles = 0;
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (url.endsWith("/marketplace/catalog")) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    if (!headers.has("PAYMENT-SIGNATURE")) {
      return new Response(JSON.stringify(challenge), {
        status: 402,
        headers: { "X-402-Price": String(price) },
      });
    }
    const [, rest] = (headers.get("PAYMENT-SIGNATURE") ?? "").split(" ");
    const amount = Number(rest?.split(":")[1]);
    if (!(amount >= price)) {
      return new Response(JSON.stringify({ detail: "insufficient payment" }), { status: 402 });
    }
    settles += 1;
    return new Response(JSON.stringify({ prints: { "ACR-INF": {} } }), {
      status: 200,
      headers: { "PAYMENT-RESPONSE": confirmationHeader(`dev-${settles}`) },
    });
  };
  return { impl, count: () => settles };
}

test("priceFromChallenge prefers accepts[].amount, falls back to X-402-Price", () => {
  assert.equal(priceFromChallenge(CHALLENGE_BODY, new Headers()), 0.0001);
  assert.equal(priceFromChallenge({}, new Headers({ "X-402-Price": "0.0005" })), 0.0005);
  assert.throws(() => priceFromChallenge({}, new Headers()));
});

test("DevPayer runs the two-act exchange and decodes the receipt", async () => {
  const stub = stubFetch();
  const payer = new DevPayer("0xagent-test", stub.impl);
  const result = await payer.pay("http://api.test/prints");
  assert.equal(result.status, 200);
  assert.equal(result.paidUsdc, 0.0001);
  assert.equal(result.transaction, "dev-1");
  assert.equal(result.payer, "0xagent-test");
});

test("DevPayer surfaces a rejected payment", async () => {
  // A gate whose paid retry still 402s (e.g. the offered price is stale).
  const alwaysReject = async (_url: string, init?: RequestInit): Promise<Response> =>
    new Headers(init?.headers).has("PAYMENT-SIGNATURE")
      ? new Response("{}", { status: 402 })
      : new Response(JSON.stringify(CHALLENGE_BODY), { status: 402 });
  const payer = new DevPayer("0xagent-test", alwaysReject);
  await assert.rejects(() => payer.pay("http://api.test/prints"), /payment rejected/);
});

test("runAgent round-robins targets and collects receipts", async () => {
  const stub = stubFetch();
  const results = await runAgent(
    { ...DEFAULTS, api: "http://api.test", count: 6, paths: ["/prints", "/vol/ACR-INF"], delayMs: 0 },
    { payer: new DevPayer("0xagent-test", stub.impl), fetchImpl: stub.impl, log: () => {} },
  );
  assert.equal(results.length, 6);
  assert.equal(stub.count(), 6);
  assert.equal(new Set(results.map((r) => r.transaction)).size, 6);
});

test("runAgent stops at the spend cap without discarding a settled payment", async () => {
  const stub = stubFetch();
  const results = await runAgent(
    { ...DEFAULTS, api: "http://api.test", count: 100, paths: ["/prints"], delayMs: 0, limitUsdc: 0.0005 },
    { payer: new DevPayer("0xagent-test", stub.impl), fetchImpl: stub.impl, log: () => {} },
  );
  // 5 × $0.0001 fits the $0.0005 cap; the loop stops BEFORE a 6th payment, so
  // settled payments == recorded results (nothing paid-but-dropped).
  assert.equal(results.length, 5);
  assert.equal(stub.count(), 5);
});

test("runAgent refuses to start when the advertised price exceeds the cap", async () => {
  const stub = stubFetch({ price: "0.02" }); // pre-flight 402 advertises $0.02/query
  await assert.rejects(
    () =>
      runAgent(
        { ...DEFAULTS, api: "http://api.test", count: 10, paths: ["/prints"], delayMs: 0, limitUsdc: 0.01 },
        { payer: new DevPayer("0xagent-test", stub.impl), fetchImpl: stub.impl, log: () => {} },
      ),
    /exceeds the spend cap/,
  );
  assert.equal(stub.count(), 0); // no money moved
});
