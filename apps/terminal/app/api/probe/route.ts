import { NextRequest, NextResponse } from "next/server";

import { CARD_HEADER, DEMO_HUMAN_LABEL, demoKey, mintCard } from "@/lib/agentcard";
import { apiBase, postLiveMeta } from "@/lib/api";
import { chainFacts } from "@/lib/chain";
import { RUNNABLE } from "@/lib/endpoints";

/* POST /api/probe — call one free endpoint and report what came back.
 *
 * The endpoints table listed twenty-seven routes and let a reader run five of
 * them. The other twenty-two are FREE, so there was never a reason beyond the
 * absence of this route: a public GET needs no payment, no wallet and no
 * session, and a reader who can see the answer arrive stops having to take the
 * documentation's word for it.
 *
 * Deliberately NOT the console route. That one performs the two-act x402
 * exchange — bare request, read the 402, present payment, retry — which is the
 * right shape when money is involved and the wrong shape here. This does one
 * GET and reports status, elapsed and a truncated body.
 *
 * The allowlist is `RUNNABLE`, derived from lib/endpoints.ts rather than typed
 * again, and matched EXACTLY: no prefix matching, so no traversal, and a path
 * the register does not mark runnable cannot be reached through here even if
 * the press would serve it. Same discipline as app/api/console/route.ts.
 *
 * TWO OPTIONAL FIELDS LET A VISITOR FEEL THE AGENT GATE rather than read about it:
 *
 *   agent_card   a card the visitor signed IN THEIR OWN TAB with a throwaway key.
 *                Forwarded upstream as AGENT-CARD, nothing else. The key never
 *                reaches this server; we only ever see the header.
 *   as: "demo-human"   this route mints a card for one of the demo fleet's wallets
 *                — key derived on the SERVER from a public label, exactly as
 *                demo_humans.py derives it — claiming the cluster HumanIdMirror
 *                records for it this window. No key ships to a browser. The point is
 *                that a visitor can watch the gate reach the HUMAN tier, which their
 *                own throwaway key never can: it is resolved to nobody.
 *
 * The allowlist is untouched by either. A card changes what the press SAYS about a
 * call, never which calls can be made.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Enough to prove the shape, not so much that a page renders a novel. */
const MAX_BODY = 1400;
/** The press is on a free tier and sleeps; a cold wake is the slow case this
 *  has to survive, and 5s (the console's budget) would fail every time. */
const TIMEOUT_MS = 12_000;

/** A card is ~600 bytes of base64. Anything much larger is not a card. */
const MAX_CARD = 2048;

export async function POST(req: NextRequest) {
  let path = "";
  let agentCard: string | undefined;
  let asDemoHuman = false;
  try {
    const body = await req.json();
    path = String(body.path ?? "");
    if (typeof body.agent_card === "string" && body.agent_card.length <= MAX_CARD) {
      agentCard = body.agent_card;
    }
    asDemoHuman = body.as === "demo-human";
  } catch {
    /* invalid JSON — rejected by the allowlist below */
  }
  if (!RUNNABLE.has(path)) {
    return NextResponse.json(
      { detail: `not runnable from here: ${path.slice(0, 80)}` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (asDemoHuman) {
    const minted = await demoHumanCard();
    if (!minted) {
      return NextResponse.json(
        { path, detail: "the demo human is not resolved this window. Run `make resolve-humans` and try again" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    agentCard = minted;
  }

  const started = Date.now();
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json", ...(agentCard ? { [CARD_HEADER]: agentCard } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    return NextResponse.json(
      {
        path,
        status: res.status,
        ms: Date.now() - started,
        // The tier, parsed here, so the page does not have to read it back out of a
        // truncated preview string. Only /agent/whoami answers with one; elsewhere
        // it is simply absent. `carded` is whether a card was SENT, so a 401 on a
        // carded run can be named as a refused card rather than a failed route.
        ...whoamiOf(text),
        carded: Boolean(agentCard),
        // Pretty-print when it parses, so the preview reads as a shape rather
        // than one long line. Non-JSON (a 404 page, an HTML error) passes
        // through as-is rather than being hidden.
        body: pretty(text).slice(0, MAX_BODY),
        truncated: text.length > MAX_BODY,
      },
      // Never cached: the whole product is that this happened just now.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // A timeout here is the ordinary free-tier cold start, not a fault, and
    // the copy says so rather than showing a reader a red error for a server
    // that is merely waking up.
    return NextResponse.json(
      {
        path,
        detail: "the press did not answer in time. It sleeps between visits, so press again",
        ms: Date.now() - started,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/** `tier` from a whoami body, or undefined for anything else. */
/** The three whoami fields the page renders as prose rather than as JSON. `tier`
 *  picks the badge; `ident_kind` says what the budget is keyed on; `human_note` is
 *  the gate's own sentence for WHY a human claim did not reach the human tier —
 *  the one line a developer actually needs when the badge says `carded` where they
 *  expected `human`, and the one that was being dropped on this floor. */
function whoamiOf(text: string): { tier?: string; ident_kind?: string; human_note?: string } {
  try {
    const j = JSON.parse(text) as { tier?: unknown; ident_kind?: unknown; human_note?: unknown };
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return { tier: str(j.tier), ident_kind: str(j.ident_kind), human_note: str(j.human_note) };
  } catch {
    return {};
  }
}

/** A card for the demo human, signed on the server with a key derived from a
 *  public label. Null when that wallet has no cluster in the current window, which
 *  is the honest answer after a rotation rather than a card the gate would refuse. */
async function demoHumanCard(): Promise<string | null> {
  const key = await demoKey(DEMO_HUMAN_LABEL);
  const { privateKeyToAccount } = await import("viem/accounts");
  const wallet = privateKeyToAccount(key).address.toLowerCase();

  // Ask the press which cluster the chain records for this wallet right now. The
  // `humans` operation returns clusters with their wallets for the current window.
  type Cluster = { id: string; window: string; payers?: Array<{ id: string } | string>; wallets?: Array<{ id: string } | string> };
  const { data } = await postLiveMeta<{ available: boolean; data?: { humanClusters: Cluster[] } }>(
    "/graph/query", { operation: "humans", variables: { first: 50 } }, TIMEOUT_MS,
  );
  const clusters = data?.data?.humanClusters ?? [];
  const mine = clusters.find((c) =>
    (c.payers ?? c.wallets ?? []).some((p) => (typeof p === "string" ? p : p.id).toLowerCase() === wallet),
  );
  if (!mine) return null;

  // Audience and chain from the gate's own challenge, never hardcoded: the snippet
  // on the page makes the same argument, and a demo that hardcoded what the gate
  // accepts would keep working after the gate changed.
  type Challenge = { audience?: string; chain_id?: number };
  const challenge: Challenge = await fetch(`${apiBase()}/agent/challenge`, {
    cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then((r) => r.json() as Promise<Challenge>).catch((): Challenge => ({}));

  const minted = await mintCard({
    privateKey: key,
    chainId: Number(challenge.chain_id ?? chainFacts().chainId),
    audience: String(challenge.audience ?? "acr-index-api"),
    name: `acr-demo-human:${DEMO_HUMAN_LABEL}`,
    role: "reader",
    humanCluster: mine.id as `0x${string}`,
  });
  return minted.header;
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
