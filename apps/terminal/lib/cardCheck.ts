/* What the agent gate made of a card a visitor pasted: "check your card" on
 * /developers. Pure, so the reading of every answer the gate can give is tested.
 *
 * The press already says exactly why it refuses a card (agentgate.py `verify`):
 * a wrong-chain card fails as "signature does not match its agent", because the
 * chain id is inside the EIP-712 domain, so recovery yields another address. That
 * sentence is true and useless to someone who does not know that, so the most
 * common refusals get the one line that tells them what to change.
 */

export type CardVerdict =
  | {
      kind: "accepted";
      tier: string;
      role: string | null;
      audience: string | null;
      agent: string | null;
      expiresInS: number | null;
      identKind: string | null;
      humanNote: string | null;
    }
  | { kind: "anonymous" }
  | { kind: "refused"; reason: string; hint: string | null }
  | { kind: "unreachable"; reason: string };

export interface ProbeAnswer {
  status?: number;
  body?: string;
  detail?: string;
}

/** The hint for a refusal, or null when the press's own reason says it all. */
export function refusalHint(reason: string, expectChainId: number | null): string | null {
  if (/signature does not match/i.test(reason)) {
    return expectChainId
      ? `Most often a card signed for another chain: this gate expects chain_id ${expectChainId} in the EIP-712 domain.`
      : "Most often a card signed for another chain: ask the gate above which chain_id it expects.";
  }
  if (/addressed to/i.test(reason)) return "The card's audience must be the one the gate names above.";
  if (/expired|not valid yet|lifetime/i.test(reason)) return "Mint a fresh one: a card lives at most 900 seconds.";
  if (/window|human|cluster|resolved/i.test(reason)) return "The human claim did not check out this window; a card with no claim is still accepted.";
  if (/malformed|base64|not an agent card/i.test(reason)) return "Paste the AGENT-CARD header value itself, base64 of {\"card\":…}.";
  return null;
}

/** Read the probe's answer for GET /agent/whoami with a pasted card. */
export function readCardCheck(httpStatus: number, out: ProbeAnswer, nowS: number, expectChainId: number | null = null): CardVerdict {
  if (httpStatus === 400) {
    const reason = out.detail ?? "not an agent card";
    return { kind: "refused", reason, hint: refusalHint(reason, expectChainId) };
  }
  if (httpStatus !== 200 || typeof out.status !== "number") {
    return { kind: "unreachable", reason: out.detail ?? `the page's proxy answered ${httpStatus}` };
  }
  let body: Record<string, unknown> = {};
  try {
    body = out.body ? (JSON.parse(out.body) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  if (out.status === 401) {
    const reason = typeof body.detail === "string" ? body.detail : "the gate refused the card";
    return { kind: "refused", reason, hint: refusalHint(reason, expectChainId) };
  }
  if (out.status !== 200) return { kind: "unreachable", reason: `the press answered ${out.status}` };
  if (body.carded !== true) return { kind: "anonymous" };
  const str = (k: string) => (typeof body[k] === "string" && body[k] ? (body[k] as string) : null);
  const exp = typeof body.expires_at === "number" ? body.expires_at : null;
  return {
    kind: "accepted",
    tier: str("tier") ?? "carded",
    role: str("role"),
    audience: str("audience"),
    agent: str("agent"),
    expiresInS: exp === null ? null : Math.max(0, Math.round(exp - nowS)),
    identKind: str("ident_kind"),
    humanNote: str("human_note"),
  };
}
