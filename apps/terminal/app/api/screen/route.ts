import { NextResponse } from "next/server";
import { apiBase } from "@/lib/api";
import { CARD_HEADER, mintCard, throwawayKey } from "@/lib/agentcard";
import { TEXT_CAP, matchedFilters, verdictOf, type ScreenVerdict } from "@/lib/screen";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* POST /api/screen — send a visitor's text through Google Cloud Model Armor, live.
 *
 * The screen sits on POST /graph/query for CARDED callers and inspects
 * `{operation, variables}` in both directions (armor.py::request_text). So the
 * smallest true demonstration is: a card, the `meta` operation, and the visitor's
 * text in `variables.note`. A 403 back names the filter Google fired and never
 * echoes the text; a 200 with the inspection counter up by one is a pass; a 200
 * with the counter unchanged is what an ANONYMOUS call looks like — never
 * screened, because a browser reader behind a proxy is not agent-to-agent
 * traffic. The `carded` toggle shows both.
 *
 * ONE CARD FOR EVERY VISITOR, minted here and never sent to a browser. A card per
 * visitor would give each of them their own per-key budget at the API, and the
 * key would be free to mint — exactly the hole the human tier exists to close.
 * One key means every visitor shares one budget, which is the honest shape.
 * Re-minted when it nears its 15-minute bound. The text is capped well under the
 * screen's own cap.
 */

const TIMEOUT_MS = 15_000;
const REMINT_MARGIN_S = 60;

interface HeldCard {
  header: string;
  expiresAt: number;
}
let held: HeldCard | null = null;
let heldKey: `0x${string}` | null = null;

async function card(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (held && held.expiresAt - now > REMINT_MARGIN_S) return held.header;
  heldKey ??= await throwawayKey();
  type Challenge = { audience?: string; chain_id?: number };
  const ch: Challenge = await fetch(`${apiBase()}/agent/challenge`, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then((r) => r.json() as Promise<Challenge>)
    .catch((): Challenge => ({}));
  const minted = await mintCard({
    privateKey: heldKey,
    chainId: Number(ch.chain_id ?? 5042002),
    audience: String(ch.audience ?? "acr-index-api"),
    name: "acr-terminal-screen-lab",
    role: "reader",
    ttlSeconds: 900,
  });
  held = { header: minted.header, expiresAt: minted.expiresAt };
  return minted.header;
}

async function armorCounts(): Promise<{ screened: number; blocked: number } | null> {
  try {
    const r = await fetch(`${apiBase()}/armor/info`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const j = (await r.json()) as { screened?: number; blocked?: number };
    return { screened: Number(j.screened ?? 0), blocked: Number(j.blocked ?? 0) };
  } catch {
    return null;
  }
}

export interface ScreenResult {
  status: number | null;
  verdict: ScreenVerdict;
  matched: string[];
  /** The refusal never carries the refused text. Asserted, not assumed. */
  echoed: boolean;
  ms: number;
  carded: boolean;
  screened_delta: number | null;
  blocked_delta: number | null;
  counts: { screened: number; blocked: number } | null;
  note: string | null;
}

export async function POST(request: Request) {
  let body: { text?: unknown; carded?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* handled below */
  }
  const text = typeof body.text === "string" ? body.text.slice(0, TEXT_CAP) : "";
  const carded = body.carded !== false;
  if (!text.trim()) {
    return NextResponse.json({ detail: "text is required" }, { status: 400 });
  }

  const before = await armorCounts();
  const started = Date.now();
  let status: number | null = null;
  let answer: unknown = null;
  let note: string | null = null;
  try {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (carded) headers[CARD_HEADER] = await card();
    const res = await fetch(`${apiBase()}/graph/query`, {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify({ operation: "meta", variables: { note: text } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    answer = await res.json().catch(() => null);
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    note = timedOut ? "the press did not answer in time. It sleeps between visits, so press again" : "the press is unreachable";
  }
  const ms = Date.now() - started;
  const after = await armorCounts();
  const screenedDelta = before && after ? after.screened - before.screened : null;
  const blockedDelta = before && after ? after.blocked - before.blocked : null;

  const out: ScreenResult = {
    status,
    verdict: verdictOf(status, screenedDelta),
    matched: matchedFilters(answer),
    echoed: answer != null && JSON.stringify(answer).includes(text),
    ms,
    carded,
    screened_delta: screenedDelta,
    blocked_delta: blockedDelta,
    counts: after,
    note,
  };
  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}
