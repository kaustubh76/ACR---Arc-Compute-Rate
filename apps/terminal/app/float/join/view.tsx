"use client";

import { IDKitRequestWidget, selfieCheck } from "@worldcoin/idkit";
import { useCallback, useState } from "react";

import { Ed } from "@/components/Ed";
import { TxLink } from "@/components/chain/TxLink";
import type { GuestBudget, GuestContext, GuestReason } from "@/lib/float";
import { isAgentAddress } from "@/lib/float";
import { fmtPrice, shortAddr } from "@/lib/format";

/* The public door: prove you are a person once, and a wallet gets a budget.

   WHY THIS PAGE DID NOT EXIST UNTIL NOW, in the repo's own words from
   `app/api/humanid/tca/route.ts`: "There is no browser widget in front of it
   yet (IDKit v4 needs an `rp_context` and a preset only the Developer Portal
   can supply, and shipping a widget built against guessed config would be a
   button that can only fail)." This is that widget, and nothing here is
   guessed: every prop was read off the installed package's own types.

   IT STORES NOTHING. No localStorage, no sessionStorage, no cookie. The
   terminal keeps credential-bearing surfaces to three paths and this is not
   one of them, so the only state is React's and it dies with the tab.

   EVERY REFUSAL HAS ITS OWN SENTENCE. The press names eight, and a page that
   collapsed them into "verification failed" could not tell a visitor whether
   to try again, install something, or stop. The reasons are the press's own
   strings, passed through rather than reworded, so a branch here is a branch
   on fact. */

type Phase = "ask" | "minting" | "open" | "claiming" | "issued" | "refused";

/** The eight the press names, each as something a person can act on.
 *
 *  Copy is a LITERAL `<Ed>` per branch rather than a lookup table, because the
 *  coverage gates match literal props: a table would render the same and
 *  silently escape the plain-copy limit and the banned-term list. */
function Refusal({ reason, detail }: { reason: GuestReason | null; detail: string }) {
  return (
    <div className="panel panel-pad section">
      <div className="card-head">
        <h4 className="mono">
          <Ed x="Not issued" p="No budget" />
        </h4>
        <span className="chip chip-breach">{reason ?? "refused"}</span>
      </div>

      {reason === "one_guest_budget_per_human" ? (
        <Ed
          as="p"
          className="standfirst"
          x="This person already holds a guest budget. The chain was asked, not our records, and it answered for this human alone."
          p="You already have a budget. The chain itself says so, not our notes."
        />
      ) : null}
      {reason === "below_sybil_floor" ? (
        <Ed
          as="p"
          className="standfirst"
          x="The credential verified, but its uniqueness score sits below the floor we set for issuing a budget."
          p="The check worked, but it did not score high enough for a budget."
        />
      ) : null}
      {reason === "unknown_or_expired_request" ? (
        <Ed
          as="p"
          className="standfirst"
          x="This join request is unknown, already spent, or past its window. Each one is single use, so start a new one rather than retrying this."
          p="This request is used up or too old. Start a new one."
        />
      ) : null}
      {reason === "wrong_environment" ? (
        <Ed
          as="p"
          className="standfirst"
          x="The proof was minted for a different World environment. A staging credential must not buy anything real, so this is refused before anything is asked of the chain."
          p="That proof came from a test setup, so it cannot be used here."
        />
      ) : null}
      {reason === "the_till_is_empty" ? (
        <Ed
          as="p"
          className="standfirst"
          x="The treasury cannot fund another guest budget right now. Nothing is wrong with the proof; there is simply no free float to commit."
          p="The treasury has no room for another budget right now. Nothing is wrong with you."
        />
      ) : null}
      {reason === "no_nullifier" || reason === "verify_failed" ? (
        <Ed
          as="p"
          className="standfirst"
          x="World's verifier did not establish a unique human from this proof, so nothing was issued and nothing was recorded."
          p="The check did not come back as a confirmed person, so no budget was given."
        />
      ) : null}
      {reason === "not_a_guest_agent" ? (
        <Ed
          as="p"
          className="standfirst"
          x="That identifier already belongs to a named agent rather than a guest. This is our bug, not yours, and it is reported as one."
          p="Something on our side clashed. This is our bug, not yours."
        />
      ) : null}

      <p className="label mono">{detail}</p>
    </div>
  );
}

function Issued({ b }: { b: GuestBudget }) {
  return (
    <div className="panel panel-pad section">
      <div className="card-head">
        <h4 className="mono">
          {fmtPrice(b.daily_cap_usdc)} USDC <span className="muted">a day</span>
        </h4>
        <span className="chip chip-teal">
          <Ed x="issued" p="yours" />
        </span>
      </div>

      <p className="label mono">
        <Ed x="wallet" p="wallet" /> <span className="num">{shortAddr(b.agent)}</span>
      </p>
      {/* The hash the chain stores, and a mask. Neither walks back to the
          identifier World gave us, which is the entire reason the on-chain id
          is a hash of it rather than it. */}
      <p className="label mono">
        <Ed x="agent id on chain" p="your id on the chain" />{" "}
        <span className="num">{b.agent_id.slice(0, 14)}…</span>
      </p>
      <p className="label mono">
        <Ed x="person" p="you" /> <span className="num">{b.human}</span>
      </p>
      {b.tx ? (
        <p className="label mono">
          <Ed x="issued in" p="done in" /> <TxLink txRef={b.tx} />
        </p>
      ) : null}

      <Ed
        as="p"
        className="standfirst"
        x="One budget per person, and asking again is refused by the vault itself rather than by a record we keep. Try it: the second attempt is the honest demonstration."
        p="One budget per person. Ask again and the chain itself says no."
      />
    </div>
  );
}

export function FloatJoinView() {
  const [agent, setAgent] = useState("");
  const [phase, setPhase] = useState<Phase>("ask");
  const [ctx, setCtx] = useState<GuestContext | null>(null);
  const [budget, setBudget] = useState<GuestBudget | null>(null);
  const [reason, setReason] = useState<GuestReason | null>(null);
  const [detail, setDetail] = useState("");
  const [widgetOpen, setWidgetOpen] = useState(false);

  const ok = isAgentAddress(agent);

  const refuse = useCallback((r: GuestReason | null, d: string) => {
    setReason(r);
    setDetail(d);
    setPhase("refused");
  }, []);

  /** Mint a join request, then open the widget against it. */
  const begin = useCallback(async () => {
    setPhase("minting");
    try {
      const res = await fetch("/api/float/idkit/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agent.trim() }),
      });
      const env = (await res.json()) as { data?: GuestContext; error?: string };
      const data = env?.data ?? null;
      if (!res.ok || !data) {
        refuse(null, env?.error || "this host could not start a join");
        return;
      }
      if (data.status !== "ok" || !data.rp_context || !data.app_id) {
        /* Stood down rather than broken: this deployment has no Developer
           Portal configuration, which is a different fact from a refusal and
           reads differently to a visitor. */
        setCtx(data);
        setPhase("open");
        return;
      }
      setCtx(data);
      setPhase("open");
      setWidgetOpen(true);
    } catch {
      refuse(null, "we could not reach our own server to start a join");
    }
  }, [agent, refuse]);

  /** Spend the proof. A proof is single use, so this is never retried. */
  const onSuccess = useCallback(
    async (result: unknown) => {
      if (!ctx?.rp_context) return;
      setWidgetOpen(false);
      setPhase("claiming");
      try {
        const res = await fetch("/api/float/idkit/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nonce: ctx.rp_context.nonce, proof: result }),
        });
        const env = (await res.json()) as {
          data?: { status?: string; claim?: GuestBudget; reason?: string };
          error?: string;
          reason?: GuestReason;
        };
        if (!res.ok) {
          refuse(env?.reason ?? null, env?.error || "the proof was refused");
          return;
        }
        const b = env?.data?.claim;
        if (!b) {
          refuse(null, env?.data?.reason || "no budget came back");
          return;
        }
        setBudget(b);
        setPhase("issued");
      } catch {
        refuse(null, "the answer did not arrive; a proof is single use, so start a new join");
      }
    },
    [ctx, refuse],
  );

  const standingDown = phase === "open" && ctx?.status === "pending";

  return (
    <>
      <div className="page-head">
        <p className="label">
          <Ed x="Guest access" p="Join" />
        </p>
        <h1 className="display">
          <Ed x="One budget, one human" p="One budget each" />
        </h1>
        <Ed
          as="p"
          className="standfirst"
          x="An agent here holds no money of its own. Prove once that you are a person and a small daily allowance opens in your name, revocable, enforced against the chain rather than against a list we keep. The wallet you give is where it spends from."
          p="Prove once that you are a real person, and a small daily allowance opens in your name. The wallet you give is where it spends from."
        />
      </div>

      {phase === "ask" || phase === "minting" ? (
        <section className="section">
          <div className="section-head">
            <h2 className="label">
              <Ed x="The wallet to fund" p="Which wallet" />
            </h2>
            {phase === "minting" ? (
              <span className="label">
                <span className="chip chip-sky">
                  <i className="dot breathe" aria-hidden />
                  <Ed x="minting a request" p="getting ready" />
                </span>
              </span>
            ) : null}
          </div>
          <Ed
            as="p"
            className="muted"
            x="The allowance is attached to this address and to nothing else. We never ask for a private key, and a page that did would be teaching the wrong thing."
            p="We attach the allowance to this address. We never ask for a private key."
          />
          <p className="label">
            <span className="ops-field">
              <input
                aria-label="the wallet address to fund"
                className="mono"
                onChange={(e) => setAgent(e.target.value)}
                placeholder="0x…"
                style={{ width: 340 }}
                value={agent}
              />
            </span>
          </p>
          <div className="btn-row">
            <button className="btn" disabled={!ok || phase === "minting"} onClick={begin} type="button">
              <Ed x="Prove I am a person" p="Prove I am a person" />
            </button>
          </div>
          {agent.trim() !== "" && !ok ? (
            <p className="label mono">
              <Ed
                x="that is not a 20 byte address"
                p="that does not look like a wallet address"
              />
            </p>
          ) : null}
        </section>
      ) : null}

      {standingDown ? (
        <section className="section">
          <div className="section-head">
            <h2 className="label">
              <Ed x="Not running here" p="Not set up here" />
            </h2>
            <span className="label">
              <span className="chip chip-sim">
                <Ed x="join stood down" p="switched off" />
              </span>
            </span>
          </div>
          <Ed
            as="p"
            className="muted"
            x="This deployment has no verification app configured, so it cannot mint a request a phone would accept. Showing a button that can only fail would be worse than saying so."
            p="This site is not set up to run the check yet, so there is no button to press."
          />
          {/* A stood-down panel that only says "no" is a dead end. This names
              the thing a reader can run instead, which is the whole point of
              keeping the page honest rather than hiding it. */}
          <Ed
            as="p"
            className="muted"
            x="The mechanism behind this page is not what is missing. Running make rehearse-float walks the same vault calls on a local chain, including a guest budget issued to a person and that same person refused a second one."
            p="The parts behind this page do work. Running make rehearse-float shows them on a test chain."
          />
          {ctx?.reason ? <p className="label mono">{ctx.reason}</p> : null}
        </section>
      ) : null}

      {phase === "claiming" ? (
        <section className="section">
          <p className="muted awaiting">
            <Ed x="asking the chain whether this person already holds one" p="checking with the chain" />
          </p>
        </section>
      ) : null}

      {phase === "issued" && budget ? <Issued b={budget} /> : null}
      {phase === "refused" ? <Refusal detail={detail} reason={reason} /> : null}

      {ctx?.status === "ok" && ctx.rp_context && ctx.app_id && ctx.action ? (
        <IDKitRequestWidget
          action={ctx.action}
          /* Only v4. Accepting legacy proofs would mean tracking two
             generations of identifier to stop one person claiming twice, and
             the uniqueness guarantee is the entire product here. */
          allow_legacy_proofs={false}
          app_id={ctx.app_id as `app_${string}`}
          onError={(code) => refuse(null, String(code))}
          onOpenChange={setWidgetOpen}
          onSuccess={onSuccess}
          open={widgetOpen}
          /* Selfie Check needs no Orb, which is the point: an assurance the
             average visitor cannot obtain protects nothing, because nobody
             passes it. */
          preset={selfieCheck()}
          rp_context={ctx.rp_context}
        />
      ) : null}
    </>
  );
}
