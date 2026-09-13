import { NextResponse } from "next/server";
import { apiBase } from "@/lib/api";
import { DEMO_HUMAN_LABEL, demoKey } from "@/lib/agentcard";
import type { HumanChallenge } from "@/lib/humans";
import { signHumanChallenge } from "@/lib/humanproof";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* POST /api/humanid/prove — the whole human path, run for a visitor to watch.
 *
 * `/api/humanid/challenge` shows the 401 and stops; this answers it. Four acts,
 * the same four `scripts/prove_human.py` performs: take the challenge, sign it,
 * present it, replay it. The last act is the one worth watching — a proof that
 * can be presented twice is a credential, and the gate refuses the second.
 *
 * `as: "demo-human"` is the ONLY accepted body. The route signs with a demo
 * buyer's key derived from its public label (`demo_humans.py`), on the server,
 * and the browser sees a header value and the gate's answer — never a key. A
 * visitor's own key is not accepted here at all: a page that took private keys
 * would be teaching exactly the wrong thing. `make prove-human` is the same flow
 * for their own wallet, on their own machine.
 */

const TIMEOUT_MS = 12_000;
const RESOURCE = "/tca/human";
const DAYS = 7;

export interface ProveResult {
  status: number | null;
  /** The signing wallet, so the reader can see WHICH wallet resolved to a person. */
  address: string | null;
  /** The gate's answer: `human` (cluster/window/wallet_count) + the TCA union. */
  body: Record<string, unknown> | null;
  /** Presenting the same proof again. 401 is the expected — and desired — answer. */
  replay_status: number | null;
  replay_detail: string | null;
  note: string | null;
}

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${apiBase()}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export async function POST(request: Request) {
  let body: { as?: unknown } = {};
  try {
    body = (await request.json()) as { as?: unknown };
  } catch {
    /* an empty body is handled below */
  }
  if (body.as !== "demo-human") {
    return NextResponse.json<ProveResult>(
      { status: null, address: null, body: null, replay_status: null, replay_detail: null,
        note: "only the demo human can be proved here; run `make prove-human` for a wallet of your own" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const out: ProveResult = { status: null, address: null, body: null, replay_status: null, replay_detail: null, note: null };
  try {
    // 1 · the challenge
    const first = await get(`${RESOURCE}?days=${DAYS}`);
    if (first.status !== 401) {
      out.status = first.status;
      out.note = first.ok ? "the gate answered without asking for a proof" : `the gate answered ${first.status}`;
      return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
    }
    const challenge = (await first.json()) as HumanChallenge & { header?: string };
    if (!challenge.nonce) {
      out.status = 401;
      out.note = "the gate issued no nonce";
      return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
    }

    // 2 · sign it, with the demo human's key, here
    const key = await demoKey(DEMO_HUMAN_LABEL);
    const host = apiBase().replace(/^https?:\/\//, "");
    const { header, address } = await signHumanChallenge({ privateKey: key, nonce: challenge.nonce, resource: RESOURCE, host });
    out.address = address;
    const headerName = challenge.header || "HUMAN-PROOF";

    // 3 · present it
    const second = await get(`${RESOURCE}?days=${DAYS}`, { [headerName]: header });
    out.status = second.status;
    out.body = (await second.json().catch(() => null)) as Record<string, unknown> | null;
    if (!second.ok) {
      out.note = String(out.body?.detail ?? "the gate refused the proof");
      return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
    }

    // 4 · replay it — the nonce must be spent
    const third = await get(`${RESOURCE}?days=${DAYS}`, { [headerName]: header });
    out.replay_status = third.status;
    const rb = (await third.json().catch(() => null)) as { detail?: string } | null;
    out.replay_detail = rb?.detail ?? null;
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    out.note = timedOut ? "the press did not answer in time. It sleeps between visits, so press again" : "the press is unreachable";
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  }
}
