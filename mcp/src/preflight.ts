/** "Can my agent pay?" — answered as a ladder, not a boolean.
 *
 * This is the question the MCP surface could not answer at all. The six original
 * tools are analytics over payments that already happened somewhere else: none of
 * them touches a payment-gated endpoint, so a developer wiring the server up
 * never even saw a 402, and the only way to find out whether their agent could
 * pay was to leave the agent and start curling.
 *
 * WHY A LADDER. "No" is the useless answer. There are seven independent reasons
 * an x402 payment cannot happen here, they fail in a fixed order, and the one
 * that fired is the only thing the developer needs. So every rung reports its own
 * verdict and its own reason, `blocked_at` names the first one that failed, and a
 * rung that could not be reached says that rather than reporting a false pass.
 *
 * Nothing on this path spends or signs. It reads the gate's own descriptors, asks
 * for a 402 challenge without answering it, and reads two balances off chain.
 */

import { arcChain, knownChainIds, type ArcChain } from "./chain.js";
import { fundingStep, payerAddress, priceFromChallenge, readBalances, validateKey } from "./pay.js";
import type { Fetchish } from "./tools.js";

export interface Rung {
  rung: string;
  ok: boolean;
  /** One sentence a developer can act on. */
  detail: string;
  /** Present when the rung could not be evaluated at all. */
  not_reached?: boolean;
}

export interface Preflight {
  can_pay: boolean;
  endpoint: string;
  api: string;
  price_usdc: number | null;
  chain_id: number | null;
  payer: string | null;
  blocked_at: string | null;
  summary: string;
  next_step: string;
  rungs: Rung[];
}

/** The gated endpoint to probe when the caller names none. The cheapest read on
 *  the paid side, and the one the service card leads with. */
export const DEFAULT_GATED_ENDPOINT = "/prints";

async function getJson(f: Fetchish, url: string): Promise<{ status: number; body: unknown }> {
  try {
    const res = await f(url);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: { unreachable: String(err).slice(0, 200) } };
  }
}

export async function canIPay(opts: {
  api: string;
  /** The carded fetch every tool uses — so rung `card` sees what the tools see. */
  fetchImpl: Fetchish;
  endpoint?: string;
  /** Raw value from the env; absence is a reported state, not an error. */
  payerKey?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Preflight> {
  const api = opts.api.replace(/\/$/, "");
  const f = opts.fetchImpl;
  const endpoint = (opts.endpoint ?? DEFAULT_GATED_ENDPOINT).trim() || DEFAULT_GATED_ENDPOINT;
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const rungs: Rung[] = [];
  const skip = (rung: string, detail: string): void => {
    rungs.push({ rung, ok: false, detail, not_reached: true });
  };

  // ── 1. the host answers, and says which chain it is on ────────────────────
  const health = await getJson(f, `${api}/health`);
  const chainId = Number((health.body as { chain_id?: unknown })?.chain_id);
  const hostOk = health.status === 200 && Number.isFinite(chainId) && chainId > 0;
  rungs.push({
    rung: "host",
    ok: hostOk,
    detail: hostOk
      ? `${api} is up on chain ${chainId} (gate ${String((health.body as { gate?: unknown }).gate ?? "?")}, ` +
        `signer ${String((health.body as { signer?: unknown }).signer ?? "?")})`
      : health.status === 0
        ? `${api} could not be reached. A free-tier press sleeps between visits — try again.`
        : `${api}/health answered ${health.status}, so this host is not serving.`,
  });

  // ── 2. a chain this package can read balances on ──────────────────────────
  let chain: ArcChain | null = null;
  if (!hostOk) {
    skip("chain", "not reached: the host did not say which chain it is on.");
  } else {
    chain = arcChain(chainId, opts.env);
    rungs.push({
      rung: "chain",
      ok: chain !== null,
      detail: chain
        ? `${chain.name} (${chain.caip2}); balances read from ${chain.publicRpc}`
        : `chain ${chainId} is not one this plugin has a profile for (knows ${knownChainIds().join(", ")}), ` +
          "so it cannot locate USDC or the Gateway wallet. Payment may still work; this check cannot verify it.",
    });
  }

  // ── 3. the card, if one is configured, is one the gate accepts ────────────
  // Informational when there is no card — an anonymous caller can still pay, it
  // just shares a rate-limit bucket. Blocking when the gate REFUSES the card,
  // because then every tool 401s, which is exactly the failure this plugin shipped
  // with: a card signed for one chain presented to a gate expecting another.
  const who = await getJson(f, `${api}/agent/whoami`);
  const tier = String((who.body as { tier?: unknown })?.tier ?? "");
  if (who.status === 200) {
    rungs.push({
      rung: "card",
      ok: true,
      detail:
        tier === "anonymous"
          ? "no card presented: calls land in the shared anonymous bucket, which can still pay."
          : `card accepted, tier "${tier}".`,
    });
  } else if (who.status === 401) {
    rungs.push({
      rung: "card",
      ok: false,
      detail:
        "the gate REFUSES this agent card (401: " +
        String((who.body as { detail?: unknown })?.detail ?? "rejected") +
        "). Every tool will fail this way. Unset ACR_AGENT_PRIVATE_KEY to call anonymously, " +
        "or check that ACR_ARC_CHAIN_ID (if you set it) matches this host's chain.",
    });
  } else {
    rungs.push({
      rung: "card",
      ok: false,
      detail: `${api}/agent/whoami answered ${who.status}, so the card could not be checked.`,
    });
  }

  // ── 4. the endpoint is actually behind the paywall ─────────────────────────
  const info = await getJson(f, `${api}/x402/info`);
  const gated = ((info.body as { gated_endpoints?: unknown })?.gated_endpoints ?? []) as string[];
  // The register carries templates like /prints/{index_id}; match those too.
  const isGated = gated.some((g) => g === path || new RegExp(`^${g.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path));
  let listedPrice: number | null = null;
  const rawPrice = Number((info.body as { price_usdc?: unknown })?.price_usdc);
  if (Number.isFinite(rawPrice)) listedPrice = rawPrice;
  if (info.status !== 200) {
    rungs.push({
      rung: "gate",
      ok: false,
      detail: `${api}/x402/info answered ${info.status}, so the paywall could not be described.`,
    });
  } else {
    rungs.push({
      rung: "gate",
      ok: isGated,
      detail: isGated
        ? `${path} is paid at $${listedPrice ?? "?"} per call, settled through ` +
          `${String((info.body as { facilitator?: unknown }).facilitator ?? "?")} to ` +
          `${String((info.body as { pay_to?: unknown }).pay_to ?? "?")}.`
        : `${path} is not a paid endpoint — it answers free. The paid ones are: ${gated.join(", ")}. ` +
          "Nothing to pay for here, so this check cannot tell you whether paying works.",
    });
  }

  // ── 5. the challenge comes back, and parses ────────────────────────────────
  let price: number | null = null;
  let payTo: string | null = null;
  const probe = await getJson(f, `${api}${path}`);
  if (probe.status === 402) {
    try {
      price = priceFromChallenge(probe.body);
      const accepts = (probe.body as { accepts?: Array<Record<string, unknown>> })?.accepts ?? [];
      payTo = String(accepts[0]?.payTo ?? "") || null;
      rungs.push({
        rung: "challenge",
        ok: true,
        detail:
          `402 received and parsed: x402 v${String((probe.body as { x402Version?: unknown }).x402Version ?? "?")}, ` +
          `scheme ${String(accepts[0]?.scheme ?? "?")}, ${String(accepts[0]?.network ?? "?")}, ` +
          `$${price} to ${payTo ?? "?"}.`,
      });
    } catch (err) {
      rungs.push({
        rung: "challenge",
        ok: false,
        detail: `a 402 came back but carried no readable price: ${String(err).slice(0, 160)}`,
      });
    }
  } else if (probe.status === 200) {
    rungs.push({
      rung: "challenge",
      ok: false,
      detail:
        `${path} answered 200 without asking for payment. Either it is free, or something already ` +
        "paid for this call — either way there is no payment here to verify.",
    });
  } else {
    rungs.push({
      rung: "challenge",
      ok: false,
      detail: `${path} answered ${probe.status}, not the 402 challenge a payer needs.`,
    });
  }
  const due = price ?? listedPrice;

  // ── 6. a payer key, which is the one thing only the developer can supply ───
  let payer: `0x${string}` | null = null;
  const rawKey = (opts.payerKey ?? "").trim();
  if (!rawKey) {
    rungs.push({
      rung: "payer",
      ok: false,
      detail:
        "no payer key configured, so this plugin cannot pay — every check above is about the gate, " +
        "not about you. Set ACR_PAYER_PRIVATE_KEY to the key of a wallet you control (never a shared " +
        "or house key) to check funding and to enable pay_and_read.",
    });
  } else {
    const parsed = validateKey(rawKey);
    if ("reason" in parsed) {
      rungs.push({ rung: "payer", ok: false, detail: `ACR_PAYER_PRIVATE_KEY is ${parsed.reason}` });
    } else {
      try {
        payer = await payerAddress(parsed.key);
        rungs.push({ rung: "payer", ok: true, detail: `paying as ${payer}.` });
      } catch (err) {
        payer = null;
        rungs.push({
          rung: "payer",
          ok: false,
          detail: `ACR_PAYER_PRIVATE_KEY could not be read as a key: ${String(err).slice(0, 160)}`,
        });
      }
    }
  }

  // ── 7. the money is where the settlement will look for it ──────────────────
  if (payer === null) {
    skip("funds", "not reached: no payer address to read balances for.");
  } else if (chain === null) {
    skip("funds", "not reached: no chain profile, so USDC and the Gateway wallet cannot be located.");
  } else if (due === null) {
    skip("funds", "not reached: the price is unknown, so there is nothing to compare a balance against.");
  } else {
    const bal = await readBalances(chain, payer);
    if (bal.wallet === null && bal.gateway === null) {
      rungs.push({
        rung: "funds",
        ok: false,
        detail: `neither balance could be read from ${bal.rpc}. Set ACR_ARC_RPC_URL to an endpoint that answers.`,
      });
    } else {
      const step = fundingStep(bal.wallet ?? 0, bal.gateway ?? 0, due);
      const amounts =
        `wallet ${bal.wallet === null ? "unreadable" : `$${bal.wallet}`}, ` +
        `Gateway ${bal.gateway === null ? "unreadable" : `$${bal.gateway}`}, price $${due}`;
      rungs.push({
        rung: "funds",
        ok: step === "ready",
        detail:
          step === "ready"
            ? `funded: ${amounts}.`
            : step === "deposit"
              ? `${amounts}. An x402 settlement spends the GATEWAY balance, not the wallet: deposit ` +
                // Bridge Kit first: most readers of this sentence arrived via
                // `npx acr-mcp` and have no clone, so a make target is not a
                // thing they can run.
                "into Circle Gateway first (Circle's Bridge Kit, or this repo's `make circle-deposit`)."
              : `${amounts}. This wallet holds no USDC on ${chain.name} at all — fund it, then deposit ` +
                "into Circle Gateway.",
      });
    }
  }

  const blocked = rungs.find((r) => !r.ok) ?? null;
  const canPay = blocked === null;
  return {
    can_pay: canPay,
    endpoint: path,
    api,
    price_usdc: due,
    chain_id: Number.isFinite(chainId) && chainId > 0 ? chainId : null,
    payer,
    blocked_at: blocked?.rung ?? null,
    summary: canPay
      ? `yes — ${payer} can pay $${due} for ${path} on ${chain?.name ?? `chain ${chainId}`}.`
      : `no — blocked at "${blocked?.rung}". ${blocked?.detail}`,
    next_step: canPay
      ? `call pay_and_read("${path}") to settle one query and get a receipt.`
      : (blocked?.detail ?? ""),
    rungs,
  };
}
