"use client";

import useSWR from "swr";

import { Ed } from "@/components/Ed";
import { TxLink } from "@/components/chain/TxLink";
import { countdown, premiumPct, statusChip } from "@/lib/float";
import type { FloatCheckpoint } from "@/lib/float";
import { fmtPrice, shortAddr } from "@/lib/format";
import { useChain } from "@/lib/useChain";
import { fetcherFor } from "@/lib/useLive";
import { useNow } from "@/lib/useNow";
import { useFloatQueue } from "@/lib/useLive";
import { gateVerdict, type WorldGateState } from "@/lib/worldGate";

/* A MODULE CONSTANT, never an inline arrow: SWR restarts its timer whenever the
   refreshInterval identity changes, so an arrow rebuilt each render never lets
   a poll fire (lib/pollCadence.test.ts). A minute here matches the route's own
   memo, and these four slots change only when an owner transaction lands. */
const GATE_POLL_MS = 60_000;

type GateAnswer = { status: string; reason?: string; gate?: WorldGateState };

/** Where the gate actually stands on chain, whether or not any press is up.
 *
 *  The queue above can only say "the press did not answer", which tells a
 *  reader nothing about an integration that works. These values are read from
 *  the vault itself, so this panel keeps answering when the press is down -- and
 *  it moves on its own the moment the owner rotates a role or sets the binding,
 *  which makes the page the witness for that rather than a description of it. */
function WorldGatePanel() {
  const chain = useChain();
  const { data } = useSWR<{ live?: boolean; data?: GateAnswer }>(
    `/api/float/gate?chain=${chain}`,
    fetcherFor(chain),
    { refreshInterval: GATE_POLL_MS, keepPreviousData: true },
  );
  const answer = data?.data;
  const gate = answer?.gate;
  const verdict = gate ? gateVerdict(gate) : null;

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="label">
          <Ed x="The gate, on chain" p="Is it switched on" />
        </h2>
        <span className="label">
          <span className={`chip ${verdict?.armed ? "chip-live" : "chip-sim"}`}>
            {verdict ? (
              verdict.armed ? (
                <Ed x="armed" p="ready" />
              ) : (
                <Ed x="not armed yet" p="not ready yet" />
              )
            ) : (
              <Ed x="reading the vault" p="checking" />
            )}
          </span>
        </span>
      </div>

      {!gate ? (
        <p className="muted">
          <Ed
            x={answer?.reason ?? "reading the vault's own slots."}
            p="checking the treasury itself."
          />
        </p>
      ) : (
        <>
          <Ed
            as="p"
            className="muted"
            x="These four values live on the vault, not on our server, so this panel answers even when the press is down and it changes by itself the moment an owner transaction lands."
            p="These come from the treasury itself, so this works even when our server is down."
          />
          <div>
            <p className="label">
              <Ed x="pins a person" p="knows who may say yes" />
            </p>
            <p className="mono">
              {verdict?.bound ? (
                <Ed x="yes · treasurerBinding is set" p="yes" />
              ) : (
                <Ed x="no · treasurerBinding is still zero" p="not yet" />
              )}
            </p>
            <p className="label">
              <Ed x="approver" p="who may say yes" />
            </p>
            <p className="mono">{shortAddr(gate.humanApprover)}</p>
            <p className="label">
              <Ed x="guest registrar" p="who may open a budget" />
            </p>
            <p className="mono">{shortAddr(gate.guestRegistrar)}</p>
            <p className="label">
              <Ed x="vault" p="treasury" />
            </p>
            <p className="mono">{shortAddr(gate.vault)}</p>
          </div>
          {verdict && !verdict.armed ? (
            <>
              <Ed
                as="p"
                className="muted"
                x="Still outstanding, and each one is a single transaction from the address that deployed the vault:"
                p="Still to do, one transaction each:"
              />
              <ul className="muted">
                {verdict.outstanding.map((o) => (
                  <li key={o} className="mono">
                    {o}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

/* The approvals card — the only place a human sees what they are approving.

   WHY THIS PAGE HAS TO EXIST. World's device profile is explicit that the
   approval screen cannot carry a transaction: "binding_message or action terms
   — Unsupported. They are not displayed on the approval page or signed into
   the ID token. The human sees the requester and user code." So the person is
   told who is asking and nothing about what they are agreeing to. Their own
   step-up guide then prescribes the remedy: save the exact action bound to the
   attempt, and show it to the user. This is that screen.

   WHAT THE CODE CAN AND CANNOT DO. The user code is on a public page on
   purpose, and it is safe because the proof it unlocks must validate as the
   ENROLLED treasurer: a stranger who completes the flow is refused as the
   wrong human, nothing moves, and the attempt is written to the chain. The
   device code — the bearer of the whole approval — never leaves the press.

   THREE STATES, BECAUSE AN EMPTY ONE WOULD LIE. "Nothing is waiting on you"
   and "we could not ask" are opposite facts that look identical, and so is "no
   gate runs on this host". Each gets its own sentence. */

/** The countdown, anchored on the press and smoothed locally.
 *
 *  The press sends a DURATION rather than its deadline, because the vault's
 *  deadline is a `block.timestamp` and subtracting a browser's wall clock from
 *  one is wrong by however far the two epochs sit apart. So the anchor is
 *  always the last answer, and the 1 Hz clock only fills the gap between polls.
 */
function secondsLeft(c: FloatCheckpoint, nowS: number, fetchedAt?: number): number {
  const fetchedS = fetchedAt ? Math.round(fetchedAt / 1000) : 0;
  const elapsed = nowS > 0 && fetchedS > 0 ? Math.max(0, nowS - fetchedS) : 0;
  return Math.max(0, c.expires_in_s - elapsed);
}

function Parked({
  c,
  nowS,
  fetchedAt,
}: {
  c: FloatCheckpoint;
  nowS: number;
  fetchedAt?: number;
}) {
  const over = premiumPct(c);
  const left = secondsLeft(c, nowS, fetchedAt);
  const waiting = c.status === "open" || c.status === "claimed";

  return (
    <div className="panel panel-pad section">
      <div className="card-head">
        <h4 className="mono">
          {fmtPrice(c.quote_usdc)} USDC <span className="muted">{c.agent}</span>
        </h4>
        <span className={`chip ${statusChip(c.status)}`}>
          {waiting ? <i className="dot breathe" aria-hidden /> : null}
          {c.status}
        </span>
      </div>

      {/* The chain's own fair price, and how far over it this quote sits. A
          percentage rather than basis points: the policy is written in bp and a
          person reads percent, and carrying both in one line is a mistake this
          terminal has already made once. */}
      <p className="label mono">
        <Ed x="ACR fair" p="fair price" />{" "}
        <span className="num">{c.fair_usdc > 0 ? fmtPrice(c.fair_usdc) : "…"}</span>
        {" · "}
        <Ed x="over fair" p="above fair" />{" "}
        <span className="num">{over === null ? "…" : `${over.toFixed(1)}%`}</span>
        {" · "}
        <span className="num">{c.units}</span> <Ed x="units" p="units" />{" "}
        {c.index ? <span className="num">{c.index}</span> : null}
      </p>

      <p className="label mono">
        <Ed x="seller" p="paid to" /> <span className="num">{shortAddr(c.seller)}</span>
      </p>

      {c.reason ? (
        <p className="standfirst">
          <Ed x="The chain's reason" p="Why it stopped" />
          {": "}
          <span className="mono">{c.reason}</span>
        </p>
      ) : null}

      {waiting && c.user_code ? (
        <>
          <p className="label">
            <Ed
              x="Open World App, confirm this code is the one on your screen, and verify."
              p="Open World App, check this code matches, and confirm."
            />
          </p>
          <p className="mono" style={{ fontSize: "var(--f-1)", letterSpacing: "var(--tr-4)" }}>
            {c.user_code}
          </p>
          <p className="label mono">
            <Ed x="expires in" p="time left" /> <span className="num">{countdown(left)}</span>
          </p>
          {c.verify_uri ? (
            <p className="label">
              <a className="section-link" href={c.verify_uri} rel="noopener noreferrer" target="_blank">
                <Ed x="Open the verification page" p="Open the page that asks" />
              </a>
            </p>
          ) : null}
        </>
      ) : null}

      {c.tx ? (
        <p className="label mono">
          <Ed x="paid in" p="paid in" /> <TxLink txRef={c.tx} />
        </p>
      ) : null}
    </div>
  );
}

export function FloatApproveView() {
  const { queue, error } = useFloatQueue();
  const nowS = useNow();

  const live = Boolean(queue?.live);
  const data = queue?.data ?? null;
  /* Three states, and "nobody has asked yet" is not one of the other two.
     Folding an unanswered first fetch into "unreachable" makes a healthy
     deployment announce a failure for the length of one request. */
  const asked = queue !== undefined || Boolean(error);
  const standingDown = live && data?.status === "pending";
  const unreachable = asked && !live;
  const parked = data?.checkpoints ?? [];

  return (
    <>
      <div className="page-head">
        <p className="label">
          <Ed x="The World gate" p="Approvals" />
        </p>
        <h1 className="display">
          <Ed x="Waiting on a human" p="Waiting on you" />
        </h1>
        <Ed
          as="p"
          className="standfirst"
          x="A payment outside its agent's own authority is not refused. It is parked on chain until a verified person approves it, and that approval is good for one payment only."
          p="A payment an agent is not allowed to make on its own is not refused. It waits here until a real person says yes, once."
        />
      </div>

      <WorldGatePanel />

      {!asked ? (
        <section className="section">
          <div className="section-head">
            <h2 className="label">
              <Ed x="Reading" p="Checking" />
            </h2>
            <span className="label">
              <span className="chip chip-sky">
                <i className="dot breathe" aria-hidden />
                <Ed x="asking the press" p="asking our server" />
              </span>
            </span>
          </div>
          <p className="muted">
            <Ed x="asking the press what is parked." p="asking our server what is waiting." />
          </p>
        </section>
      ) : null}

      {unreachable ? (
        <section className="section">
          <div className="section-head">
            <h2 className="label">
              <Ed x="No answer" p="No answer" />
            </h2>
            <span className="label">
              <span className="chip chip-sim">
                <Ed x="press unreachable" p="server asleep" />
              </span>
            </span>
          </div>
          <p className="muted" style={{ maxWidth: "var(--measure)" }}>
            <Ed
              x="An empty queue and an unreachable press look the same on a screen and mean opposite things, so this page says nothing rather than show you a page of nothing. It retries by itself."
              p="We cannot reach our server, so we will not pretend nothing is waiting. This page keeps trying."
            />
          </p>
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
                <Ed x="gate stood down" p="switched off" />
              </span>
            </span>
          </div>
          <p className="muted" style={{ maxWidth: "var(--measure)" }}>
            <Ed
              x="This host is not running the World gate, so nothing can be parked for approval here. The key that signs an approval belongs on one machine, and a host that merely has the code must not poll for approvals it cannot sign."
              p="This machine is not set up to ask for approvals. The key that signs one lives somewhere else, on purpose."
            />
          </p>
          {data?.reason ? <p className="label mono">{data.reason}</p> : null}
        </section>
      ) : null}

      {live && !standingDown && parked.length === 0 ? (
        <section className="section">
          <p className="muted awaiting">
            <Ed x="nothing is waiting on you" p="nothing is waiting on you" />
          </p>
        </section>
      ) : null}

      {parked.map((c) => (
        <Parked c={c} fetchedAt={queue?.fetchedAt} key={c.id} nowS={nowS} />
      ))}
    </>
  );
}
