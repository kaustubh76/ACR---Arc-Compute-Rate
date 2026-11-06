"use client";

import { useEffect, useMemo, useState } from "react";

import { Ed } from "@/components/Ed";
import type { FloatVaultState } from "@/lib/float";
import { LADDER, bandCeiling, escalates, headroom, parseDenialCode, rungState } from "@/lib/floatLadder";
import { fmtPrice } from "@/lib/format";
import type { DryRun } from "@/lib/routeInput";
import { useDebounced } from "@/lib/useDebounced";
import { useFloatClassify } from "@/lib/useLive";

/* The ladder, driven.

   WHAT THIS IS. `FloatVault._check` is twelve ordered rungs and every one of
   them returns its own English sentence. `classify` is that same ladder as a
   free `view` — the contract's own words: "so a caller can ask 'would this be
   refused, and why' without a transaction and get the chain's real answer". So
   a visitor moves a quote, the request climbs, and the rung that bites names
   itself in the vault's language rather than ours.

   NOTHING IS PREDICTED HERE. The numbers beside the sliders are THRESHOLDS the
   reader can check against: the chain's fair price, the ceiling the band puts
   on it, the agent's own authority, what is left of today's cap. Which rung
   bites is only ever the chain's answer, printed where it arrives. A local copy
   of the ladder would be a second source of truth that disagrees under
   rounding, and the whole value of this surface is that it does not.

   RUNG ELEVEN IS DRAWN DIFFERENTLY ON PURPOSE. It is the one code that is not a
   refusal — the contract calls it an escalation and exempts it from burning the
   nonce — so it leaves the ladder sideways in gold instead of stopping it in
   red. Painting a parked payment as a refusal would say the opposite of what
   the vault did.

   IT SPENDS NOTHING. Every answer on this screen came from a `view`. */

/** An address the vault's allowlist does not carry, so a reader can watch the
 *  seller rung bite. Non-zero deliberately: zero trips the same rung by a
 *  different clause, and the one worth showing is "this seller is not on the
 *  list" rather than "you named nobody". */
const STRANGER_SELLER = "0x0000000000000000000000000000000000000001";
/** A name the vault never enrolled. `agentOf` answers `exists: false` for it,
 *  which is rung two. */
const STRANGER_AGENT = "nobody";

const QUOTE_MAX = 60;
const UNITS_FAIR = 4_000;
const DEBOUNCE_MS = 260;

type Preset = { key: string; quote: number; units: number };

export function Ladder({
  vault,
  onVerdict,
}: {
  vault: FloatVaultState;
  /** The code the chain just returned, so the money path above can run only
   *  when the vault says it would pay. Reported rather than recomputed: two
   *  surfaces reading one answer cannot disagree about it. */
  onVerdict?: (code: number | null) => void;
}) {
  const agents = vault.agents ?? [];
  const seller = vault.seller ?? "";
  const bandBps = vault.policy?.max_premium_bps ?? 0;
  const humanBandBps = vault.policy?.human_max_premium_bps ?? 0;

  const [agent, setAgent] = useState(agents[0]?.name ?? STRANGER_AGENT);
  const [toStranger, setToStranger] = useState(false);
  const [quote, setQuote] = useState(1);
  const [units, setUnits] = useState(UNITS_FAIR);

  const standing = agents.find((a) => a.name === agent) ?? null;

  /* The read is keyed on the settled value, not the live one: dragging a range
     input fires a change per step and each step is a different SWR key, so an
     undebounced slider is one chain read per pixel.

     THE `useMemo` IS LOAD-BEARING AND NOT TIDINESS. `useDebounced` keys its
     timer on the value's IDENTITY, so a fresh object literal here would re-arm
     the timer on every render — and worse, settling triggers a render, which
     builds another literal, which re-arms, which settles: a loop with no
     steady state. Memoized on the four primitives, the object changes only
     when a control does. Same hazard as an inline `refreshInterval`, which
     `lib/pollCadence.test.ts` guards for the same reason. */
  const controls = useMemo(
    () => ({ quote, units, agent, toStranger }),
    [quote, units, agent, toStranger],
  );
  const settled = useDebounced(controls, DEBOUNCE_MS);
  const req: DryRun | null = seller
    ? {
        agent: settled.agent,
        seller: settled.toStranger ? STRANGER_SELLER : seller,
        units: settled.units,
        quoteUsdc: settled.quote,
      }
    : null;
  const { verdict, reading } = useFloatClassify(req);

  const answer = verdict?.data;
  const code = answer?.status === "ok" ? parseDenialCode(answer.code) : null;
  const fair = answer?.status === "ok" ? (answer.fair_usdc ?? 0) : 0;
  const ceiling = bandCeiling(fair, bandBps);
  const humanCeiling = bandCeiling(fair, humanBandBps);
  const left = standing ? headroom(standing.daily_cap_usdc, standing.spent_usdc) : null;

  useEffect(() => {
    onVerdict?.(code);
  }, [code, onVerdict]);

  /* THREE PRESETS, AND EACH ONE RELIABLY LANDS WHERE ITS LABEL SAYS. A preset
     only moves the same controls a reader can move by hand, so nothing here can
     show a result the sliders could not reach.

     The cut one is worth recording: a "drain it, fifty times the units" button
     looked like the judge console's second weapon and was measured landing on
     the BAND rung every time, because the band is checked before the cap and a
     fifty-times quote fails it first. The cap rung is not reachable at all
     while the agent's per-request threshold sits below what is left of its day
     — which is the contract working, not a gap. A button that promises one
     refusal and delivers another teaches the wrong thing, so it is gone rather
     than relabelled.

     PARKING TAKES ARITHMETIC, because the window is narrow: the quote has to
     clear the agent's own authority while staying inside the band. The unit
     price comes from the chain's own last answer (`fair / units`), the units
     are sized so that fair sits just above the threshold, and the quote lands a
     hair over it. Measured against the live vault: units 19,100, quote 5.02,
     threshold 5.00, fair 5.01375 — rung eleven, "over per-request threshold". */
  const unitPrice = fair > 0 && units > 0 ? fair / units : 0;
  const threshold = standing?.per_request_usdc ?? 0;

  /* NOT memoized, unlike `controls` above. Nothing keys on this array's
     identity — it is read into two ceilings and a click handler — and the React
     Compiler refuses a `useMemo` it cannot prove it is preserving, which is a
     build error rather than a warning. A memo that buys nothing and fails the
     compiler is worse than the three multiplications it was saving. */
  const base = fair > 0 ? fair : 1;
  const parkUnits = unitPrice > 0 && threshold > 0 ? Math.ceil((threshold * 1.004) / unitPrice) : UNITS_FAIR;
  const parkQuote = threshold > 0 ? Number((threshold + 0.005).toFixed(3)) : base;
  const presets: Preset[] = [
    { key: "fair", quote: Number(base.toFixed(2)), units: UNITS_FAIR },
    { key: "over", quote: Number((base * 3).toFixed(2)), units: UNITS_FAIR },
    { key: "park", quote: parkQuote, units: parkUnits },
  ];

  /* The sliders have to be able to REACH every preset, or a button would set a
     value the control silently clamps and the ladder would answer a question
     nobody asked. Both ceilings are derived from the presets rather than fixed. */
  const quoteMax = Math.max(QUOTE_MAX, ...presets.map((p) => Math.ceil(p.quote * 1.2)));
  const unitsMax = Math.max(UNITS_FAIR * 60, ...presets.map((p) => Math.ceil(p.units * 1.2)));

  const apply = (p: Preset) => {
    setQuote(p.quote);
    setUnits(p.units);
  };

  return (
    <section className="section anchor-target" id="ladder">
      <div className="section-head">
        <h2 className="label">
          <Ed x="The ladder, and where your quote stops on it" p="Try to make it pay too much" />
        </h2>
        <span className="label">
          {reading ? (
            <span className="chip chip-sky">
              <i className="dot breathe" aria-hidden />
              <Ed x="reading the chain" p="asking the chain" />
            </span>
          ) : (
            <span className="chip chip-sim">
              <Ed x="costs nothing, signs nothing" p="this never spends money" />
            </span>
          )}
        </span>
      </div>

      <Ed
        as="p"
        className="muted"
        style={{ fontSize: "var(--t-4)", marginTop: 0, maxWidth: "var(--measure)" }}
        x="Twelve checks run in a fixed order and the first one to fail answers. This asks the vault the same question a payment asks, as a read that moves no money, and prints the sentence it gives back."
        p="The vault runs twelve checks in order. This asks it the same question a real payment asks, without spending anything."
      />

      {/* A LADDER THAT CANNOT ASK IS WORSE THAN NO LADDER. The chain never
          supplies a seller, so without one configured no dry run is ever
          issued and all twelve rungs sit blank with nothing saying why. That
          is the only state on this surface that would lie by omission. */}
      {seller ? null : (
        <p className="label">
          <span className="chip chip-sim">
            <Ed
              x="this host has no seller configured, so nothing can be dry run"
              p="this site has no shop set up, so there is nothing to try"
            />
          </span>
        </p>
      )}

      <div className="flow-controls">
        <span className="label">
          <Ed x="whose money" p="which robot" />
        </span>
        {agents.map((a) => (
          <button
            aria-pressed={agent === a.name}
            className={`chip${agent === a.name ? " chip-gold" : ""}`}
            key={a.name}
            onClick={() => setAgent(a.name)}
            type="button"
          >
            <span className="mono">{a.name}</span>
          </button>
        ))}
        <button
          aria-pressed={agent === STRANGER_AGENT}
          className={`chip${agent === STRANGER_AGENT ? " chip-gold" : ""}`}
          onClick={() => setAgent(STRANGER_AGENT)}
          type="button"
        >
          <Ed x="one it never enrolled" p="one it has never heard of" />
        </button>
      </div>

      <div className="flow-controls">
        <span className="label">
          <Ed x="paying whom" p="paying who" />
        </span>
        <button
          aria-pressed={!toStranger}
          className={`chip${!toStranger ? " chip-gold" : ""}`}
          onClick={() => setToStranger(false)}
          type="button"
        >
          <Ed x="the seller on its list" p="a shop it is allowed to use" />
        </button>
        <button
          aria-pressed={toStranger}
          className={`chip${toStranger ? " chip-gold" : ""}`}
          onClick={() => setToStranger(true)}
          type="button"
        >
          <Ed x="a seller not on it" p="a shop it is not allowed to use" />
        </button>
      </div>

      <div className="flow-controls">
        <label className="label">
          <Ed x="quote" p="the bill" />{" "}
          <input
            aria-label="the quote in usdc"
            max={quoteMax}
            min={0}
            onChange={(e) => setQuote(Number(e.target.value))}
            step={0.005}
            type="range"
            value={quote}
          />{" "}
          <b className="gold mono">{fmtPrice(quote)}</b>
        </label>
        <label className="label">
          <Ed x="units" p="how much" />{" "}
          <input
            aria-label="how many units the quote covers"
            max={unitsMax}
            min={0}
            onChange={(e) => setUnits(Number(e.target.value))}
            step={100}
            type="range"
            value={units}
          />{" "}
          <b className="gold mono">{units}</b>
        </label>
      </div>

      <div className="lab-presets">
        <span className="label">
          <Ed x="or try one of these" p="or try one of these" />
        </span>
        <button onClick={() => apply(presets[0])} type="button">
          <Ed x="quote it fairly" p="charge a fair price" />
        </button>
        <button onClick={() => apply(presets[1])} type="button">
          <Ed x="overcharge by three times" p="charge three times too much" />
        </button>
        <button onClick={() => apply(presets[2])} type="button">
          <Ed x="push it past its own authority" p="ask for more than it may do alone" />
        </button>
      </div>

      <div className="rung-quote">
        <span className="muted">
          <Ed x="ACR fair" p="fair price" />
        </span>
        <span className="num">{fair > 0 ? fmtPrice(fair) : "…"}</span>
        <span className="muted">
          <Ed x="band tops out at" p="the most it may pay" />
        </span>
        <span className="num">{ceiling === null ? "…" : fmtPrice(ceiling)}</span>
        <span className="muted">
          <Ed x="its own authority" p="what it may do alone" />
        </span>
        <span className="num">{standing ? fmtPrice(standing.per_request_usdc) : "…"}</span>
        <span className="muted">
          <Ed x="left today" p="left today" />
        </span>
        <span className="num">{left === null ? "…" : fmtPrice(left)}</span>
      </div>

      <div aria-label="the twelve checks, in order" className="flow flow-rungs" role="list">
        {LADDER.map((rung) => {
          const state = rungState(rung, code);
          return (
            <div className="flow-station" data-node={rung.name} key={rung.code} role="listitem">
              <div className={`flow-node ${state}`}>
                <div className="rung">
                  <span className="rung-no">{rung.code}</span>
                  <span className="label">
                    <RungName name={rung.name} />
                  </span>
                  {state === "blocked" || state === "lit" ? (
                    <span className="rung-said">{answer?.chain_reason || ""}</span>
                  ) : null}
                </div>
                {state === "lit" && escalates(code) ? (
                  <div className="rung-fork">
                    <Ed
                      as="p"
                      className="standfirst"
                      style={{ fontSize: "var(--t-4)", marginTop: 0 }}
                      x="This is not a refusal. The payment is parked on chain and waits for a verified person to release it, once, for this request only."
                      p="This is not a no. It waits for a real person to say yes, once, for this one payment."
                    />
                    <p className="label">
                      <a className="section-link" href="/float/approve">
                        <Ed x="See what that person is shown" p="See what that person sees" />
                      </a>
                    </p>
                    <p className="label mono">
                      <Ed x="a person's band tops out at" p="a person may allow up to" />{" "}
                      <span className="num">{humanCeiling === null ? "…" : fmtPrice(humanCeiling)}</span>
                    </p>
                  </div>
                ) : null}
              </div>
              <span className="flow-arrow" aria-hidden />
            </div>
          );
        })}
      </div>

      <div aria-live="polite" className="flow-log" role="status">
        {code === null ? (
          <Ed x="no answer from the vault yet." p="no answer from the vault yet." />
        ) : code === 0 ? (
          <Ed
            x="cleared all twelve. The vault would pay this, and the agent's wallet would never hold it."
            p="it passed all twelve checks. The vault would pay this bill itself."
          />
        ) : (
          <>{answer?.chain_reason || ""}</>
        )}
      </div>

      <Ed
        as="p"
        className="muted"
        style={{ fontSize: "var(--t-3)", marginTop: "var(--s-3)", maxWidth: "var(--measure)" }}
        x="That sentence is the vault's own, returned by the same function a payment runs through, and it is the chain that chose the rung. An approval widens the band; it never removes it."
        p="That line comes from the vault itself, not from this page. A person can allow more than usual, but never an unpriced amount."
      />
    </section>
  );
}

/** The rung, in words, with the contract's constant as the expert label.
 *
 *  A switch of literal `<Ed>` branches rather than a lookup table, for the
 *  reason `app/float/join/view.tsx` states about its eight refusals: the
 *  coverage gates match literal props, and a table would render identically
 *  while escaping the plain-copy limit and the banned-term list. */
function RungName({ name }: { name: string }) {
  if (name === "D_PAUSED") return <Ed x="treasury paused" p="the treasury is switched off" />;
  if (name === "D_UNKNOWN_AGENT") return <Ed x="agent enrolled" p="is this robot known" />;
  if (name === "D_FROZEN") return <Ed x="not frozen by policy" p="is it allowed to spend" />;
  if (name === "D_SELLER") return <Ed x="seller allowed" p="is the shop allowed" />;
  if (name === "D_REPLAY") return <Ed x="request not replayed" p="is this a repeat" />;
  if (name === "D_UNITS") return <Ed x="units sane" p="is the amount sensible" />;
  if (name === "D_NO_PRINT") return <Ed x="a price exists" p="do we know the going rate" />;
  if (name === "D_STALE") return <Ed x="the price is fresh" p="is that rate recent" />;
  if (name === "D_ROTATED") return <Ed x="quoted against this price" p="was the bill priced on it" />;
  if (name === "D_BAND") return <Ed x="inside the fair band" p="is the bill close to fair" />;
  if (name === "D_PER_REQUEST") return <Ed x="within its own authority" p="may it do this alone" />;
  return <Ed x="inside today's cap" p="is there budget left today" />;
}
