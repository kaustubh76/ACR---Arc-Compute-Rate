"use client";

import { useState } from "react";
import { Ed } from "../Ed";
import { useHumanId } from "@/lib/useLive";
import type { HumanChallenge } from "@/lib/humans";

/* The human gate, shown rather than described.

   The page directly above this already does the same thing for money: the API
   console renders the real 402 before a cent moves, because a paywall a reader
   watched happen is worth more than one they were told about. This is that move
   for personhood. The nonce is minted by the press, is single use, and expires;
   nothing here is staged.

   Showing a challenge gives nothing away. It authorizes no call on its own, and
   the nullifier behind a real credential never leaves the press: what a reader
   sees is the shape of the demand, not a key. */

interface ChallengeResult {
  challenge: HumanChallenge | null;
  status: number | null;
  note: string | null;
}

/** One row of the challenge. Labels dual-render; values never do. */
function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="register-row" style={{ display: "flex", gap: 12, padding: "3px 0" }}>
      <span className="muted" style={{ minWidth: 132, fontSize: 12.5 }}>
        {label}
      </span>
      <span className="mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>
        {children}
      </span>
    </div>
  );
}

export function HumanProof() {
  const info = useHumanId()?.data?.info ?? null;
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<ChallengeResult | null>(null);

  async function ask() {
    setAsking(true);
    try {
      const res = await fetch("/api/humanid/challenge", { method: "POST" });
      setResult((await res.json()) as ChallengeResult);
    } catch {
      setResult({ challenge: null, status: null, note: "the browser could not reach the press" });
    } finally {
      setAsking(false);
    }
  }

  const ch = result?.challenge ?? null;

  return (
    <section className="section">
      <div className="section-head">
        <Ed x="The human gate" p="The real-person gate" className="label" />
      </div>

      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 13, maxWidth: 68 * 9, marginTop: 0 }}
        x="Free, like every other tape read. What stands in front of it is proof that one person is asking, which is what makes it safe to union a whole fleet of wallets into a single bill."
        p="Free to use, but you have to prove you are one real person before it will answer."
      />

      <button
        type="button"
        className="chip"
        onClick={ask}
        disabled={asking}
        style={{ cursor: asking ? "default" : "pointer" }}
      >
        <Ed x="Ask the gate what it wants" p="Ask what it needs" />
      </button>

      {ch && (
        <div style={{ marginTop: 14 }}>
          <Row label={<Ed x="scheme" p="method" />}>{ch.scheme}</Row>
          {ch.app_id && <Row label={<Ed x="app id" p="which app" />}>{ch.app_id}</Row>}
          <Row label={<Ed x="nonce · single use" p="one-time code" />}>{ch.nonce}</Row>
          <Row label={<Ed x="expires in" p="good for" />}>{ch.expires_in_seconds}s</Row>
          {/* Scoped to one path on purpose: a proof minted for another route, or
              for another service entirely, cannot be presented here. */}
          <Row label={<Ed x="scoped to" p="only works for" />}>{ch.resource}</Row>
          <Row label={<Ed x="header" p="sent back as" />}>{ch.header}</Row>
          <Row label={<Ed x="identities" p="account type" />}>
            {ch.sandbox ? (
              <Ed x="Sandbox · simulator, not Orb-verified" p="test accounts, not checked people" />
            ) : (
              <Ed x="production" p="checked people" />
            )}
          </Row>
        </div>
      )}

      {/* Not a challenge, and the reason said plainly. A 200 here would mean the
          gate admitted an unauthenticated caller, which is worth stating rather
          than rendering as an empty panel. */}
      {result && !ch && result.note && (
        <p className="mono muted" role="status" style={{ fontSize: 12.5, marginTop: 12 }}>
          {result.note}
        </p>
      )}

      {/* What it would take to ANSWER, read from the running gate rather than
          asserted. Under agentkit with no wallet registered in AgentBook this
          admits nobody, and that is the gate working, not a bug. */}
      {info && (
        <p className="muted" style={{ fontSize: 13, marginTop: 12, maxWidth: 68 * 9 }}>
          {info.backend === "agentkit" ? (
            <Ed
              x="Answered by an agent wallet registered in World's AgentBook: it signs, and the press recovers the address and asks AgentBook whose it is. A wallet nobody has registered resolves to nobody."
              p="Answered by a wallet that World already knows belongs to a checked person."
            />
          ) : info.backend === "worldid" ? (
            <Ed
              x="Answered with a World ID proof from the World App, checked against World's own verifier."
              p="Answered by scanning a code in the World App."
            />
          ) : (
            <Ed
              x="Dev gate. The nonce is real and genuinely single use, so replay is exercised rather than assumed, but nothing here proves a person exists."
              p="Practice gate: the one-time code is real, but it does not check that anyone is."
            />
          )}{" "}
          <Ed x="Proofs verified since this press started:" p="Proofs checked since we started:" />{" "}
          {info.verified_proofs}
        </p>
      )}
    </section>
  );
}
