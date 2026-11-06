"use client";

import type { KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Ed } from "@/components/Ed";
import type { FloatVaultState } from "@/lib/float";
import type { RungPaint } from "@/lib/floatLadder";
import {
  LADDER,
  bandCeiling,
  clearedCount,
  escalates,
  headroom,
  parseDenialCode,
  rungSymbol,
  stoppedAt,
  walkedState,
} from "@/lib/floatLadder";
import { modelOf } from "@/lib/floatRunway";
import { fmtInt, fmtPrice } from "@/lib/format";
import { stepScrub } from "@/lib/scrub";
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
/** How long each rung holds before the next lights. Twelve of these is 840ms,
 *  which is long enough to read as a sequence and short enough that a reader
 *  dragging a slider is never waiting on the animation for the answer. */
const WALK_MS = 70;

type Preset = { key: string; quote: number; units: number };

export function Ladder({
  vault,
  onVerdict,
  index,
}: {
  vault: FloatVaultState;
  /** The model to price against, as the runway picked it. Undefined leaves the
   *  choice to the chain, which uses the store's first index. */
  index?: string;
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
  /* The print behind the numbers below. `index` when the runway picked one,
     otherwise the store's first, which is what `classifyQuote` falls back to —
     so the chip names what the chain used rather than what we asked for. */
  const prints = vault.prints ?? [];
  const priceFor = (index ? prints.find((p) => p.index === index) : prints[0]) ?? null;

  /* The read is keyed on the settled value, not the live one: dragging a range
     input fires a change per step and each step is a different SWR key, so an
     undebounced slider is one chain read per pixel.

     THE `useMemo` IS LOAD-BEARING AND NOT TIDINESS. `useDebounced` keys its
     timer on the value's IDENTITY, so a fresh object literal here would re-arm
     the timer on every render — and worse, settling triggers a render, which
     builds another literal, which re-arms, which settles: a loop with no
     steady state. Memoized on the five primitives, the object changes only
     when a control does. Same hazard as an inline `refreshInterval`, which
     `lib/pollCadence.test.ts` guards for the same reason.

     `index` IS ONE OF THE FIVE because it arrives from the runway, a sibling
     panel: picking a model there has to settle through the same debounce as a
     slider here, or a click would fire a chain read the next keystroke
     replaces. */
  const controls = useMemo(
    () => ({ quote, units, agent, toStranger, index }),
    [quote, units, agent, toStranger, index],
  );
  const settled = useDebounced(controls, DEBOUNCE_MS);
  const req: DryRun | null = seller
    ? {
        agent: settled.agent,
        seller: settled.toStranger ? STRANGER_SELLER : seller,
        units: settled.units,
        quoteUsdc: settled.quote,
        ...(settled.index ? { index: settled.index } : {}),
      }
    : null;
  const { verdict, reading } = useFloatClassify(req);

  const answer = verdict?.data;
  const code = answer?.status === "ok" ? parseDenialCode(answer.code) : null;
  const fair = answer?.status === "ok" ? (answer.fair_usdc ?? 0) : 0;
  const ceiling = bandCeiling(fair, bandBps);
  const humanCeiling = bandCeiling(fair, humanBandBps);
  const left = standing ? headroom(standing.daily_cap_usdc, standing.spent_usdc) : null;
  const maxAgeS = vault.policy?.max_print_age_s ?? null;

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
  /* THE TWELVE CHECKS, WALKED RATHER THAN SNAPPED.

     The ladder used to paint its whole answer in one frame, so twelve ordered
     checks never looked like they ran: the page went from twelve dashed boxes
     to twelve teal ones with nothing in between. Lighting them in the
     contract's own order, 70ms apart, is under a second for all twelve and it
     is the only thing on this surface that shows the MECHANISM rather than the
     result. Honest, too: the order is `_check`'s and the rung it stops on is
     the chain's, not a guess this component made.

     RE-WALKS ON A NEW ANSWER, keyed on the classified quote as well as the
     code, because dragging to a different quote that happens to trip the same
     rung is still a new answer and has to read as one. `keepPreviousData`
     means the object is stable until a verdict actually lands, so this is not
     once per render.

     THE INTERVAL IS CLEARED ON UNMOUNT AND BEFORE EACH RESTART, as
     `components/loop/LoopFlow.tsx` and `components/float/MoneyPath.tsx` both
     do. Reduced motion jumps to the settled state: the information is in the
     twelve marks, and only the travelling was ever motion. */
  /* `useState<number>` explicitly: `LADDER` is `as const`, so `LADDER.length`
     is the literal type 12 and an inferred state could only ever hold 12. */
  const [walk, setWalk] = useState<number>(LADDER.length);
  const walkTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (walkTimer.current) clearInterval(walkTimer.current);
    },
    [],
  );
  const walkKey = `${code}|${answer?.quote_usdc ?? ""}|${answer?.fair_usdc ?? ""}`;
  const [walkFor, setWalkFor] = useState(walkKey);
  /* THE REWIND HAS TO HAPPEN DURING RENDER, NOT IN AN EFFECT.
     Measured with a MutationObserver: resetting the walk in an effect painted
     the finished answer for one frame and THEN rewound to replay it, so a new
     verdict flashed its own result before animating towards it. An effect runs
     after paint, which is exactly one frame too late.
     This is React's documented way to adjust state when the inputs change: the
     set during render re-renders immediately without painting the stale value,
     so the first frame a reader sees is already the start of the walk. */
  if (walkFor !== walkKey) {
    setWalkFor(walkKey);
    setWalk(0);
  }
  useEffect(() => {
    if (walkTimer.current) clearInterval(walkTimer.current);
    /* With no answer every rung paints `running` whatever `walk` says, so
       there is nothing to drive. */
    if (code === null) return;
    /* Read here rather than during render: `matchMedia` has no server answer,
       and a render-phase read would differ between the server pass and the
       first client pass. Reduced motion lands on the settled state, which is
       where the walk was going anyway. */
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setWalk(LADDER.length);
      return;
    }
    let i = 0;
    walkTimer.current = setInterval(() => {
      i += 1;
      setWalk(i);
      if (i >= LADDER.length && walkTimer.current) clearInterval(walkTimer.current);
    }, WALK_MS);
    return () => {
      if (walkTimer.current) clearInterval(walkTimer.current);
    };
    /* `walkKey` carries the code and the quote the answer was about; `code` is
       read inside and is part of that key. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walkKey]);

  /* WHICH CHECK THE READOUT SHOWS. A rung code, 1..12, and always exactly one:
     a tablist with no selection has nothing to read out. */
  const [sel, setSel] = useState<number>(1);
  const railRef = useRef<HTMLDivElement | null>(null);

  /* THE READOUT FOLLOWS THE VERDICT. A new answer selects the rung that
     answered, so the one thing a reader wants is already open and the panel is
     never a click away from the point. Adjusted during render for the same
     reason the walk is: an effect runs after paint, so the panel would show the
     previous answer's rung for a frame. When everything cleared there is no
     deciding rung, and check one is an honest place to rest rather than an
     invented selection. */
  const [selFor, setSelFor] = useState(walkKey);
  if (selFor !== walkKey) {
    setSelFor(walkKey);
    setSel(stoppedAt(code) ?? 1);
  }

  const cleared = clearedCount(code);
  const stopRung = stoppedAt(code);
  const selRung = LADDER[Math.min(Math.max(sel, 1), LADDER.length) - 1];
  const selPaint = walkedState(selRung, code, walk);

  /* ARROWS ALONG THE RAIL, borrowed rather than written. `stepScrub` is the
     chart crosshair's key handling: pure, tested, Left/Right/Home/End over a
     0-based index, and `undefined` for a key it does not handle so everything
     else passes through. It returns null for Escape, which would mean "no
     selection"; a tablist always has one, so that is ignored here rather than
     clearing.

     FOCUS HAS TO FOLLOW THE SELECTION. With a roving tabindex the cell a
     reader just left becomes unfocusable, so without this the keyboard is
     stranded on a cell it can no longer tab out of predictably. */
  const onRailKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = stepScrub(sel - 1, e.key, LADDER.length);
    if (next === undefined || next === null) return;
    e.preventDefault();
    setSel(next + 1);
    railRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${next + 1}"]`)?.focus();
  };

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
          {/* WHICH MODEL, NAMED. The runway offers the choice one panel up and
              the band, the fair total and the verdict below all move with it,
              so a reader who picks a model has to be able to see that this is
              the one being asked about. The chain supplies the string. */}
          {priceFor ? (
            <span className="chip chip-wrap">
              <Ed x="pricing" p="using" /> <span className="mono">{modelOf(priceFor)}</span>
            </span>
          ) : null}{" "}
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
        {/* `.lab-presets button.on` has existed in the stylesheet all along and
            nothing set it, so the three presets gave no sign of which one the
            sliders were sitting on. `aria-pressed` carries the same fact to a
            reader who cannot see the colour. */}
        {presets.map((pre, i) => {
          const on = quote === pre.quote && units === pre.units;
          return (
            <button
              aria-pressed={on}
              className={on ? "on" : undefined}
              key={pre.key}
              onClick={() => apply(pre)}
              type="button"
            >
              {i === 0 ? (
                <Ed x="quote it fairly" p="charge a fair price" />
              ) : i === 1 ? (
                <Ed x="overcharge by three times" p="charge three times too much" />
              ) : (
                <Ed x="push it past its own authority" p="ask for more than it may do alone" />
              )}
            </button>
          );
        })}
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

      {/* HOW FAR IT GOT, IN ONE LINE, above the rail that shows it. */}
      <p className="label mono">
        {code === null ? (
          <Ed x="asking the vault" p="asking the vault" />
        ) : code === 0 ? (
          <Ed x="cleared all twelve checks" p="it passed all twelve checks" />
        ) : (
          <>
            <Ed x="stopped at check" p="stopped at check" /> <span className="num">{code}</span>{" "}
            <Ed x="of twelve" p="of twelve" />
            {" · "}
            <span className="num">{Math.min(cleared, walk)}</span> <Ed x="cleared first" p="passed first" />
          </>
        )}
      </p>

      {/* THE RAIL. Twelve cells where there were twelve cards, and a tablist
          rather than twelve buttons: one tab stop, arrows along it. The walk
          lights them left to right, which on a rail reads as a scan. */}
      <div
        aria-label="the twelve checks, in order"
        className="rung-rail"
        onKeyDown={onRailKey}
        ref={railRef}
        role="tablist"
      >
        {LADDER.map((rung) => {
          const state = walkedState(rung, code, walk);
          const on = sel === rung.code;
          return (
            <button
              aria-controls="rung-panel"
              aria-selected={on}
              className={`rung-cell ${state}`}
              data-cell={rung.code}
              data-node={rung.name}
              id={`rung-tab-${rung.code}`}
              key={rung.code}
              onClick={() => setSel(rung.code)}
              role="tab"
              tabIndex={on ? 0 : -1}
              type="button"
            >
              <span className="rung-cell-no">{rung.code}</span>
              {/* The mark differs in SHAPE, which is what SC 1.4.1 asks of a
                  state that would otherwise be a colour. The name and the
                  state in words follow it for assistive tech, which is a
                  different requirement with its own answer. */}
              <span aria-hidden className="rung-cell-mark">
                {rungSymbol(state)}
              </span>
              <span className="sr-only">
                <RungName name={rung.name} />
                {", "}
                <PaintWord paint={state} />
              </span>
            </button>
          );
        })}
      </div>

      {/* THE READOUT. One of these instead of twelve cards, and it opens on
          the rung that ANSWERED, so the verdict is on screen without a click. */}
      <div
        aria-labelledby={`rung-tab-${sel}`}
        className={`rung-panel ${selPaint}`}
        id="rung-panel"
        role="tabpanel"
      >
        <div className="rung-panel-head">
          <span className="rung-no mono">
            <Ed x="check" p="check" /> {sel}
          </span>
          <b className="label">
            <RungName name={selRung.name} />
          </b>
          <span className="label muted">
            <PaintWord paint={selPaint} />
          </span>
          {sel === stopRung ? (
            <span className={escalates(code) ? "chip chip-gold" : "chip chip-breach"}>
              <Ed x="this is where it stopped" p="this is where it stopped" />
            </span>
          ) : null}
        </div>

        <div className="rung-why">
          <RungWhy
            ceiling={ceiling}
            enrolled={Boolean(standing?.exists)}
            left={left}
            maxAgeS={maxAgeS}
            name={selRung.name}
            paused={Boolean(vault.paused)}
            priced={fair > 0}
            quote={quote}
            threshold={standing ? standing.per_request_usdc : null}
            toStranger={toStranger}
            units={units}
          />
        </div>

        {sel === stopRung && answer?.chain_reason ? (
          <span className="rung-said">{answer.chain_reason}</span>
        ) : null}

        {sel === stopRung && escalates(code) ? (
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

/** The rung's state, in words, for a reader who gets the page as text.
 *
 *  THE MARK AND THIS ARE NOT THE SAME JOB. `rungSymbol` gives a glyph that
 *  differs in shape, which is what SC 1.4.1 asks for: information not carried
 *  by colour alone. This is read aloud instead of the glyph, because "check ten,
 *  inside the fair band, tick" is not a sentence and "stopped here" is. */
function PaintWord({ paint }: { paint: RungPaint }) {
  if (paint === "passed") return <Ed x="cleared" p="passed" />;
  if (paint === "blocked") return <Ed x="stopped here" p="it stopped here" />;
  if (paint === "lit") return <Ed x="parked for a person" p="waiting for a person" />;
  if (paint === "running") return <Ed x="still asking" p="still asking" />;
  if (paint === "queued") return <Ed x="not run yet" p="not run yet" />;
  return <Ed x="never reached" p="never reached" />;
}

/** What one check actually compares, with the live numbers this surface already
 *  holds.
 *
 *  NO NEW READS AND NO INVENTED ONES. Every figure below is already derived for
 *  the quote row above the ladder, so opening a rung costs nothing. Three of the
 *  twelve have no comparison on this page — a freeze is a flag only the vault
 *  holds, a replay is a nonce, a rotation is which print the quote was signed
 *  against — and those say what the check IS and show no number, rather than
 *  borrowing a plausible one from a neighbour.
 *
 *  A switch of literal `<Ed>` branches, for the reason `RungName` states: the
 *  coverage gates match literal props, and a lookup table would render the same
 *  while escaping the plain-copy limit. */
function RungWhy({
  name,
  quote,
  units,
  ceiling,
  threshold,
  left,
  enrolled,
  paused,
  priced,
  maxAgeS,
  toStranger,
}: {
  name: string;
  quote: number;
  units: number;
  ceiling: number | null;
  threshold: number | null;
  left: number | null;
  enrolled: boolean;
  paused: boolean;
  priced: boolean;
  maxAgeS: number | null;
  toStranger: boolean;
}) {
  if (name === "D_PAUSED") {
    return paused ? (
      <Ed as="p" x="the treasury's own switch is off, so nothing spends" p="the treasury is switched off, so nothing can be spent" />
    ) : (
      <Ed as="p" x="the treasury's own switch is on" p="the treasury is switched on" />
    );
  }
  if (name === "D_UNKNOWN_AGENT") {
    return enrolled ? (
      <Ed as="p" x="this agent has a budget on this vault" p="this robot has a budget here" />
    ) : (
      <Ed as="p" x="this agent was never enrolled, so it has no budget to spend" p="this robot was never signed up, so it has nothing to spend" />
    );
  }
  if (name === "D_FROZEN") {
    return <Ed as="p" x="whether this agent has been frozen since it was enrolled, which only the vault knows" p="whether this robot has been stopped since it signed up" />;
  }
  if (name === "D_SELLER") {
    return toStranger ? (
      <Ed as="p" x="this seller is not on the vault's list, so the payment cannot be made at all" p="this shop is not on the list, so the payment cannot happen" />
    ) : (
      <Ed as="p" x="this seller is on the vault's list" p="this shop is on the list" />
    );
  }
  if (name === "D_REPLAY") {
    return <Ed as="p" x="whether this exact request has already been spent, by its nonce" p="whether this same bill has already been paid once" />;
  }
  if (name === "D_UNITS") {
    return (
      <p>
        <Ed x="the units being priced" p="how much is being bought" /> <b>{fmtInt(units)}</b>
      </p>
    );
  }
  if (name === "D_NO_PRINT") {
    return priced ? (
      <Ed as="p" x="this model has a price on chain to check against" p="we know the going rate for this model" />
    ) : (
      <Ed as="p" x="no price on chain for this model, so there is nothing to check against" p="we do not know the going rate, so there is nothing to compare" />
    );
  }
  if (name === "D_STALE") {
    return (
      <p>
        <Ed x="a price older than this is refused" p="a rate older than this is refused" />{" "}
        <b>{maxAgeS === null ? "\u2026" : `${fmtInt(maxAgeS)}s`}</b>
      </p>
    );
  }
  if (name === "D_ROTATED") {
    return <Ed as="p" x="whether the quote was signed against the price the vault is now reading" p="whether the bill was worked out from the rate we just looked up" />;
  }
  if (name === "D_BAND") {
    return (
      <p>
        <Ed x="this quote" p="this bill" /> <b>{fmtPrice(quote)}</b>{" "}
        <Ed x="against the band's top" p="against the most it may pay" />{" "}
        <b>{ceiling === null ? "\u2026" : fmtPrice(ceiling)}</b>
      </p>
    );
  }
  if (name === "D_PER_REQUEST") {
    return (
      <p>
        <Ed x="this quote" p="this bill" /> <b>{fmtPrice(quote)}</b>{" "}
        <Ed x="against what it may do alone" p="against what it may do on its own" />{" "}
        <b>{threshold === null ? "\u2026" : fmtPrice(threshold)}</b>
      </p>
    );
  }
  return (
    <p>
      <Ed x="this quote" p="this bill" /> <b>{fmtPrice(quote)}</b>{" "}
      <Ed x="against what is left of today" p="against what is left today" />{" "}
      <b>{left === null ? "\u2026" : fmtPrice(left)}</b>
    </p>
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
