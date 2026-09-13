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

/** What `/api/humanid/prove` answers — the four acts, run on the server with the
 *  demo human's key. `body` is the gate's own 200: the person, then the bill. */
interface ProveResult {
  status: number | null;
  address: string | null;
  body: {
    available?: boolean;
    reason?: string;
    human?: { cluster?: string; window?: number; wallet_count?: number };
    purchases?: number;
    spent_usdc?: number;
    vw_slippage_bp?: number | null;
    overpaid_usdc?: number;
    reroute?: { from: string; to: string; saving_bp: number } | null;
    detail?: string;
  } | null;
  replay_status: number | null;
  replay_detail: string | null;
  note: string | null;
}

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 10)}…${a.slice(-4)}` : a);

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
  const [proving, setProving] = useState(false);
  const [proof, setProof] = useState<ProveResult | null>(null);

  /* The answer, not only the question. Signed on the server with a demo buyer's
     key derived from a public label, so the browser watches a proof verified
     and a nonce spent without ever holding a key. */
  async function prove() {
    setProving(true);
    try {
      const res = await fetch("/api/humanid/prove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ as: "demo-human" }),
      });
      setProof((await res.json()) as ProveResult);
    } catch {
      setProof({ status: null, address: null, body: null, replay_status: null, replay_detail: null, note: "the browser could not reach the press" });
    } finally {
      setProving(false);
    }
  }

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

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="chip"
          onClick={ask}
          disabled={asking}
          style={{ cursor: asking ? "default" : "pointer" }}
        >
          <Ed x="Ask the gate what it wants" p="Ask what it needs" />
        </button>
        <button
          type="button"
          className="chip chip-gold"
          onClick={prove}
          disabled={proving}
          style={{ cursor: proving ? "default" : "pointer" }}
        >
          <Ed x="Prove as a demo human" p="Prove a test person" />
        </button>
      </div>

      {proof && (
        <div style={{ marginTop: 14 }}>
          {proof.status === 200 && proof.body ? (
            <>
              <Row label={<Ed x="signed by" p="wallet used" />}>{proof.address ? short(proof.address) : "…"}</Row>
              <Row label={<Ed x="resolved to" p="belongs to" />}>
                <Ed x="one person" p="one real person" /> · {proof.body.human?.cluster ? short(proof.body.human.cluster) : "…"} ·{" "}
                <Ed x="window" p="week" /> {proof.body.human?.window ?? "…"} · {proof.body.human?.wallet_count ?? "…"}{" "}
                <Ed x="wallets, never listed" p="wallets, and it never says which" />
              </Row>
              {proof.body.available ? (
                <Row label={<Ed x="one bill, all wallets" p="one bill for all of them" />}>
                  {proof.body.purchases} <Ed x="purchases" p="buys" /> · ${(proof.body.spent_usdc ?? 0).toFixed(5)} ·{" "}
                  {proof.body.vw_slippage_bp ?? "…"} bp <Ed x="slippage" p="over the going rate" /> · ${(proof.body.overpaid_usdc ?? 0).toFixed(6)}{" "}
                  <Ed x="overpaid" p="too much" />
                  {proof.body.reroute ? (
                    <>
                      {" · "}
                      <Ed x="reroute saves" p="switching saves" /> {proof.body.reroute.saving_bp} bp
                    </>
                  ) : null}
                </Row>
              ) : (
                <Row label={<Ed x="one bill, all wallets" p="one bill for all of them" />}>{proof.body.reason ?? "…"}</Row>
              )}
              <Row label={<Ed x="replayed" p="used twice" />}>
                <span className={proof.replay_status === 401 ? "green" : "vermilion"}>{proof.replay_status ?? "…"}</span>{" "}
                {proof.replay_detail ? <span className="muted">{proof.replay_detail}</span> : null}
              </Row>
              <Ed
                as="p"
                className="muted"
                style={{ fontSize: 12.5, marginTop: 8 }}
                x="A person, not a wallet, was the unit: one proof, every wallet they own on one bill, and the nonce spent on the way through."
                p="The unit was a person, not a wallet: one proof covered all their wallets, and the one-time code cannot be reused."
              />
            </>
          ) : (
            <p className="mono muted" role="status" style={{ fontSize: 12.5 }}>
              {proof.status ? `${proof.status} · ` : ""}
              {proof.note ?? proof.body?.detail ?? "no answer"}
            </p>
          )}
        </div>
      )}

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
          {info.agentbook ? (
            <>
              {" · "}
              <Ed x="roster:" p="list of known wallets:" /> {info.agentbook}
              {info.agentbook === "fixture" ? (
                <>
                  {" "}
                  <Ed x="(the demo wallets, not World Chain)" p="(the test wallets only)" />
                </>
              ) : null}
            </>
          ) : null}
        </p>
      )}
    </section>
  );
}
