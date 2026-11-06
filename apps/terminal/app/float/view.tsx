"use client";

import { useCallback, useState } from "react";

import { Ed } from "@/components/Ed";
import { Ladder } from "@/components/float/Ladder";
import { MoneyPath } from "@/components/float/MoneyPath";
import { Runway } from "@/components/float/Runway";
import { Tape } from "@/components/float/Tape";
import { VaultMeter } from "@/components/float/VaultMeter";
import { Yield } from "@/components/float/Yield";
import { fmtPrice } from "@/lib/format";
import { setChain } from "@/lib/useChain";
import { useFloatVault } from "@/lib/useLive";

/* ACR Float, the front door.

   FOUR HONEST STATES, BECAUSE THREE OF THEM LOOK IDENTICAL AS AN EMPTY PAGE.
   "Nobody has asked yet", "this chain has no treasury", "this host is not
   configured for one" and "the chain did not answer" are four different facts
   and only two of them are anything a reader can act on. The approvals card
   already pays for this lesson in its own comment; the same discipline here.

   THE TREASURY IS ON ONE CHAIN, and the page says so rather than zeroing. A
   buffer of 0.00 with empty sleeves is a perfectly readable screen that happens
   to describe a treasury which does not exist on the network the visitor has
   selected. `lib/mainnetOnly.test.ts` exists because this terminal once served
   one chain's numbers under another chain's label, and an invented zero is the
   same lie with better manners. */

export function FloatView() {
  const { vault, error } = useFloatVault();
  const [code, setCode] = useState<number | null>(null);

  /* A stable identity: `Ladder` reports its verdict from an effect, and an
     inline arrow here would be a new function every render and re-fire it. The
     same hazard `lib/pollCadence.test.ts` guards for SWR intervals. */
  const onVerdict = useCallback((c: number | null) => setCode(c), []);

  const asked = vault !== undefined || Boolean(error);
  const data = vault?.data ?? null;
  const live = Boolean(vault?.live);
  const standingDown = data?.status === "pending";
  const unreachable = asked && !live && !standingDown;

  return (
    <>
      <div className="page-head">
        <p className="label">
          <Ed x="ACR Float" p="Safe spending" />
        </p>
        <h1 className="display">
          <Ed x="The agent holds no money" p="The robot holds no money" />
        </h1>
        <Ed
          as="p"
          className="standfirst"
          x="Give an agent a wallet and its worst case is the balance. Give it a limit and its worst case is the limit. Neither asks what an overcharge actually fails, which is whether the price is fair. This treasury asks that, in public, before it pays."
          p="A robot with a wallet can lose all of it. A robot with a limit can lose the limit. Neither asks the real question: is this price fair?"
        />
      </div>

      {!asked ? (
        <section className="section">
          <div className="section-head">
            <h2 className="label">
              <Ed x="Reading" p="Checking" />
            </h2>
            <span className="label">
              <span className="chip chip-sky">
                <i className="dot breathe" aria-hidden />
                <Ed x="reading the treasury" p="reading the treasury" />
              </span>
            </span>
          </div>
          <p className="muted">
            <Ed x="asking the chain what the treasury holds." p="asking the chain what it holds." />
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
                <Ed x="chain unreachable" p="cannot reach the chain" />
              </span>
            </span>
          </div>
          <Ed
            as="p"
            className="muted"
            style={{ maxWidth: "var(--measure)" }}
            x="An empty treasury and an unreadable one look the same on a screen and mean opposite things, so this page says nothing rather than show you a page of zeroes. It retries by itself."
            p="We cannot read the chain, so we will not show you zeroes as if they were real. This page keeps trying."
          />
        </section>
      ) : null}

      {standingDown ? (
        <section className="section">
          <div className="section-head">
            <h2 className="label">
              <Ed x="Not on this chain" p="Not on this network" />
            </h2>
            <span className="label">
              <span className="chip chip-sim">
                <Ed x="no treasury here" p="nothing here" />
              </span>
            </span>
          </div>
          <Ed
            as="p"
            className="muted"
            style={{ maxWidth: "var(--measure)" }}
            x="The treasury is deployed on one chain, and this is not the one selected. Switch the network in the strip above to read it. Nothing is wrong; there is simply no vault at this address on this network, and inventing one would be worse than saying so."
            p="This treasury lives on one network, and you are on the other one. Switch the network above to see it."
          />
          {data?.switch_to ? (
            /* One click rather than a hunt. The terminal opens on mainnet by
               default and the vault is on one other network, so without this a
               judge arriving at the URL reads a correct sentence and then has
               to go looking for the control it names. `setChain` hard-reloads
               by design, which is why this is a button and not a link. */
            <div className="btn-row">
              <button className="btn" onClick={() => setChain(data.switch_to!)} type="button">
                <Ed x="Switch to the network it runs on" p="Switch to the right network" />
              </button>
            </div>
          ) : null}
          {data?.reason ? <p className="label mono">{data.reason}</p> : null}
        </section>
      ) : null}

      {live && data?.status === "ok" ? (
        <>
          <section className="section">
            <div className="section-head">
              <h2 className="label">
                <Ed x="One payment, and who touches the money" p="How a payment works" />
              </h2>
              <span className="label">
                {data.paused ? (
                  <span className="chip chip-breach">
                    <Ed x="treasury paused" p="switched off" />
                  </span>
                ) : data.partial ? (
                  /* The chain asked us to slow down, so some numbers below are
                     absent rather than zero. Saying "live" over a part-read
                     panel is the lie this flag exists to prevent. */
                  <span className="chip chip-sim">
                    <i className="dot breathe" aria-hidden />
                    <Ed x="the chain is busy; some figures are missing" p="the chain is busy, so some numbers are missing" />
                  </span>
                ) : (
                  <span className="chip chip-teal">
                    <i className="dot breathe" aria-hidden />
                    <Ed x="live on chain" p="live" />
                  </span>
                )}
              </span>
            </div>
            <MoneyPath paying={code === 0} vault={data} />
          </section>

          {/* Runway before the ladder: a reader meets the money, learns what
              it buys, and only then drives the policy that spends it. */}
          <Runway vault={data} />

          <Ladder onVerdict={onVerdict} vault={data} />

          <VaultMeter vault={data} />

          {/* Where the float is, then what being there earned it. */}
          <Yield vault={data} />

          <Tape />

          <section className="section">
            <div className="section-head">
              <h2 className="label">
                <Ed x="The two doors" p="Two things you can do" />
              </h2>
            </div>
            <div className="facts">
              <div className="fact">
                <p className="fact-value">
                  <Ed x="Get a budget" p="Get a budget" />
                </p>
                <Ed
                  as="p"
                  className="fact-gloss"
                  x="Prove once that you are a person and a wallet you name gets a small daily allowance from this treasury."
                  p="Prove once that you are a real person and a wallet you pick gets a small daily allowance."
                />
                <p className="label">
                  <a className="section-link" href="/float/join">
                    <Ed x="Open the door" p="Open the door" />
                  </a>
                </p>
              </div>
              <div className="fact">
                <p className="fact-value">
                  <Ed x="Clear a payment" p="Say yes to a payment" />
                </p>
                <Ed
                  as="p"
                  className="fact-gloss"
                  x="What a verified person is shown before they release a payment the agent could not authorise on its own."
                  p="What a real person sees before they allow a payment the robot cannot make alone."
                />
                <p className="label">
                  <a className="section-link" href="/float/approve">
                    <Ed x="See the queue" p="See what is waiting" />
                  </a>
                </p>
              </div>
              <div className="fact">
                <p className="fact-value">
                  <Ed x="Today's cap" p="Each guest gets" />
                </p>
                <p className="fact-gloss mono">
                  <span className="num">
                    {data.guest_daily_cap_usdc === undefined ? "…" : fmtPrice(data.guest_daily_cap_usdc)}
                  </span>{" "}
                  <Ed x="USDC per guest agent, per day" p="USDC a day, for each person" />
                </p>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}
