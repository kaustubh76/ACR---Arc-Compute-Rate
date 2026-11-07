"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Ed } from "@/components/Ed";
import { AddressChip } from "@/components/chain/AddressChip";
import { MoneyPath } from "@/components/float/MoneyPath";
import { TxLink } from "@/components/chain/TxLink";
import type { FloatVaultState } from "@/lib/float";
import { fmtInt, fmtPrice } from "@/lib/format";
import { CHAINS } from "@/lib/chainChoice";
import { useChain } from "@/lib/useChain";
import { HOPS, litAt, runOrder, type BeatKey, type HopId } from "@/lib/floatOne";
import { useOnePayment } from "@/lib/useLive";

/* One payment, in three dimensions, over the flat diagram that still carries it.
 *
 * WHAT THE THIRD DIMENSION BUYS. `MoneyPath` draws the money path correctly and
 * the thing it claims is an ORDER: the exact shortfall left the yield venue and
 * only then was the seller paid, inside one transaction. Flat, that order is
 * where the legs were drawn. Here the vertical axis IS the log index off
 * `/api/float/walk`, so the pull sits below the pay because the receipt says it
 * does, and a contradicted order comes out visibly wrong. The camera moves so a
 * reader can check the ordering from an angle the author did not choose.
 *
 * THE FLAT DIAGRAM IS THE FALLBACK AND THE TWIN, not a legacy path. It renders
 * on the server, whenever WebGL is missing, and under reduced motion. It is
 * already accurate, already carries both registers, and already honours the
 * motion preference, so the scene is an enhancement with a floor under it
 * rather than a replacement with a hole. Until the probe answers, the flat one
 * is what is on screen, which also means the server and the first client paint
 * agree and nothing flashes.
 *
 * THE MODEL'S SENTENCE IS GATED BEHIND A DISCLOSURE AND BADGED. Every figure on
 * this page is read off the chain; that paragraph is not, and it is the only
 * prose on any ACR surface that a gate cannot check. So it costs a deliberate
 * click, it says who wrote it, and with no key configured it is simply absent.
 * There is no placeholder sentence, because a fallback is not an answer. */

/** How long each station holds before the next lights. `MoneyPath` uses 900ms
 *  for five stations and `LoopFlow` 650ms for six; six stations with a chain
 *  read in the middle of them want the slower end. */
const STEP_MS = 900;

/** What a run is doing, which is not the same question as how far it has got.
 *
 *  `asking` is its own state because the chain is being asked a real question
 *  and the answer can be no. A reader who presses Run and sees the gate light
 *  immediately has been told the payment was allowed before anyone checked. */
type Gate =
  | { at: "idle" }
  | { at: "asking" }
  | { at: "allowed" }
  | { at: "refused"; code: number; reason: string }
  | { at: "unreadable"; reason: string };

/** What each hop is doing, in both registers.
 *
 *  LITERAL `<Ed x= p=>` ON PURPOSE, as a table of elements rather than a table
 *  of strings. Every gate this repo has reads `x="…"` and `p="…"` out of the
 *  SOURCE: the jargon ban, the em-dash ban, the 140-character plain ceiling and
 *  the 160-character float ceiling. Build these from variables and all four go
 *  blind, which is exactly the hole the model's narration already has and the
 *  reason that one is gated behind a disclosure.
 *
 *  ONE TABLE, TWO SURFACES. The docked row under the scene and the table under
 *  that render the same elements, so a hover and a reader who cannot hover are
 *  looking at the same sentence and it cannot drift. */
const HOP_SAYS: Record<HopId, React.ReactNode> = {
  ask: (
    <Ed
      x="The agent may only ask. It signs nothing, it is nobody's payee, and its own wallet holds nothing before and after."
      p="The robot can only ask. It never holds the money and never signs anything."
    />
  ),
  submit: (
    <Ed
      x="onlyExecutor. It may submit a spend and open a checkpoint, and nothing else: it cannot change a policy, lift a band or approve one."
      p="Only this key may send the request. It cannot change the rules or approve anything."
    />
  ),
  price: (
    <Ed
      x="The hourly print, read from the store the receipt itself names, with the print id it was quoted against."
      p="The hourly rate, read from the place the receipt names."
    />
  ),
  check: (
    <Ed
      x="The vault recomputes the fair total itself from that print before it pays, and refuses a quote outside the band."
      p="The vault works out the fair price itself before it pays."
    />
  ),
  release: (
    <Ed
      x="The buffer was short, so the exact shortfall leaves the venue in this same transaction, paid to the treasury and not to our sleeve."
      p="There was not enough ready money, so the missing part comes straight from savings to the treasury."
    />
  ),
  record: (
    <Ed
      x="Our sleeve records what the venue delivered, requested against delivered, one log after the venue's own."
      p="Our savings wrapper writes down what arrived."
    />
  ),
  pay: (
    <Ed
      x="The USDC transfer that pays the seller, for the quote the chain had already checked against the fair total."
      p="The money goes to the shop, for the price the chain checked."
    />
  ),
  escalate: (
    <Ed
      x="Only on an escalation. A signature bound to this exact request, inside its window, usable once and never re-aimed."
      p="Only when a payment is held: one approval, for this exact request, once."
    />
  ),
};

/** The hop's own name, register-neutral: these are the parties, not prose. */
const HOP_NAME: Record<HopId, string> = {
  ask: "agent → executor",
  submit: "executor → treasury",
  price: "print store → benchmark",
  check: "benchmark → treasury",
  release: "morpho → treasury",
  record: "morpho → our sleeve",
  pay: "treasury → seller",
  escalate: "approver ⇢ treasury",
};

const Scene = dynamic(() => import("@/components/float/OnePaymentScene"), {
  ssr: false,
  loading: () => <div className="scene scene-idle" />,
});

/** Does this browser have WebGL at all? Asked once, and the probe cleans up.
 *
 *  A PROBE THAT KEEPS ITS CONTEXT IS A LEAK WITH TEETH. `getContext("webgl")`
 *  on a throwaway canvas creates a real GL context, browsers cap how many may
 *  be live at once (around sixteen in Chrome), and when the cap is reached the
 *  OLDEST is dropped. So a probe that re-ran on every `prefers-reduced-motion`
 *  change could eventually take out the context belonging to the scene it was
 *  asked about. Released through `WEBGL_lose_context`, and memoised at module
 *  scope so the answer is computed once per page rather than once per mount. */
let webgl: boolean | null = null;

function hasWebgl(): boolean {
  if (webgl !== null) return webgl;
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    webgl = Boolean(gl);
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl = false;
  }
  return webgl;
}

/** Can this reader be shown a moving WebGL scene?
 *
 *  `null` until the browser answers, and `null` renders the flat diagram. Three
 *  ways to answer no: no WebGL, a reader who asked for less motion, and a GPU
 *  context that was lost after we started. The third one matters because a lost
 *  context leaves an empty box forever, and this section has a correct SVG
 *  sitting right there. */
function useCanRender(lost: boolean): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    const decide = () => setOk(!still.matches && hasWebgl());
    decide();
    still.addEventListener("change", decide);
    return () => still.removeEventListener("change", decide);
  }, []);
  return lost ? false : ok;
}

/** The chain's own verdict on the order, as a chip a reader can act on. */
function OrderChip({ verdict }: { verdict: string }) {
  if (verdict === "in_order") {
    return (
      <span className="chip chip-teal chip-wrap">
        <Ed x="the pull came before the pay" p="savings moved first, then the shop was paid" />
      </span>
    );
  }
  if (verdict === "out_of_order") {
    return (
      <span className="chip chip-breach chip-wrap">
        <Ed x="the logs do not show the pull first" p="the records do not show savings moving first" />
      </span>
    );
  }
  if (verdict === "unproven") {
    return (
      <span className="chip chip-sim chip-wrap">
        <Ed x="it claimed just in time and a log is missing" p="it says savings paid, but a record is missing" />
      </span>
    );
  }
  return (
    <span className="chip chip-sky chip-wrap">
      <Ed x="the buffer covered this one, so there is no order to show" p="there was enough ready money, so nothing moved from savings" />
    </span>
  );
}

/** Claude's plain-English paragraph, asked for only when a reader opens it. */
function Narration({ tx }: { tx: string }) {
  const chain = useChain();
  const [state, setState] = useState<"shut" | "asking" | "done" | "off">("shut");
  const [text, setText] = useState("");

  async function open(e: React.SyntheticEvent<HTMLDetailsElement>) {
    if (!e.currentTarget.open || state !== "shut") return;
    setState("asking");
    try {
      const r = await fetch(`/api/float/explain?chain=${chain}`, {
        body: JSON.stringify({ tx }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const j = await r.json();
      const say = j?.data?.explanation;
      if (typeof say === "string" && say.length > 0) {
        setText(say);
        setState("done");
      } else {
        setState("off");
      }
    } catch {
      setState("off");
    }
  }

  return (
    <details className="narrate" onToggle={open}>
      <summary className="narrate-head">
        <Ed x="Read this payment in a sentence" p="Say this in plain words" />
      </summary>
      {state === "asking" ? (
        <p className="label muted">
          <i aria-hidden className="dot breathe" />
          <Ed x="asking the model" p="asking" />
        </p>
      ) : state === "off" ? (
        <p className="label muted">
          <Ed
            x="no narrator is configured on this host, so there is nothing to show"
            p="this is switched off here, so there is nothing to show"
          />
        </p>
      ) : state === "done" ? (
        <>
          <p className="narrate-body">{text}</p>
          <p className="label muted">
            <Ed
              x="Written by a model from the figures above. Every number on this page is read off the chain; this paragraph is not."
              p="A model wrote this from the numbers above. The numbers come from the chain. This sentence does not."
            />
          </p>
        </>
      ) : null}
    </details>
  );
}

export function OnePayment3D({ vault, paying }: { vault: FloatVaultState; paying: boolean }) {
  const one = useOnePayment();
  /* A LOST CONTEXT DEGRADES RATHER THAN GOING BLANK. R3F does not recover a
     context the GPU took away, so the section hands itself back to the flat
     SVG, which is accurate and needs no GPU at all. */
  /* WHICH HOP THE POINTER IS ON. The scene reports it; the sentence lives out
     here, because `.scene` is `role="img"` and everything inside it is pruned
     from the accessibility tree. A tooltip in there would be invisible to the
     readers most in need of it. */
  const [hop, setHop] = useState<HopId | null>(null);
  const [lost, setLost] = useState(false);
  const lostContext = useCallback(() => setLost(true), []);
  const can = useCanRender(lost);
  /* THE EXPLORER OF THE CHAIN BEING SERVED. `TxLink` defaults to mainnet's
     while this vault lives on one chain, which is how every testnet receipt
     on the tape once deep-linked into an explorer that had never seen it.
     The same trap, the same fix (components/float/Tape.tsx:122-131). */
  const chain = useChain();
  const explorer = CHAINS[chain].profile.explorer;

  /* --- the run ------------------------------------------------------------
   *
   * PRESSING RUN ASKS THE CHAIN, and the flow goes no further than the answer
   * allows. The request is built from the newest real payment, so it is a
   * genuine question about a real payment shape rather than a made-up one:
   * would this same spend be allowed right now. It can be refused for reasons
   * that move on their own, which is the point. The print rotates, the band
   * moves with it, the daily cap rolls, the agent can be frozen.
   *
   * `classify` is a `view`. It signs nothing, spends nothing and needs no key,
   * so this is repeatable at a booth indefinitely and a visitor can drive it.
   *
   * ASKED WITH A FETCH AND NOT THE SWR HOOK, deliberately. `useFloatClassify`
   * exists for the ladder's slider, where a verdict should follow the input and
   * keep following it. A button is one question asked once, and a poller behind
   * it would re-answer a run that had already finished. Same shape as the
   * narration disclosure below. */
  const [step, setStep] = useState(-1);
  const [gate, setGate] = useState<Gate>({ at: "idle" });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  /* Cleared on unmount AND before each restart, as `MoneyPath`, `LoopFlow` and
     `Ladder` all do. */
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const order: BeatKey[] = useMemo(
    () => (one.status === "live" ? runOrder(one.beats, one.jit) : []),
    [one],
  );
  const lit = useMemo(() => litAt(order, step), [order, step]);
  /* Walking, not merely started: the gate is step 1 and the money stations
     begin at 2, so a run parked at the gate is not moving anything. */
  const walking = step >= 2 && step < order.length - 1;
  const busy = gate.at === "asking" || walking;

  /** The same payment, asked of the chain again. `null` when the page cannot
   *  name every part of it, because a dry run with a guessed field would be
   *  classifying something nobody asked about. */
  function request(): { url: string; quote: number } | null {
    if (one.status !== "live") return null;
    const name = vault.agents?.find(
      (a) => a.agent_id?.toLowerCase() === one.agentId?.toLowerCase(),
    )?.name;
    if (!name || !one.sellerAddr || one.units === null || one.quoteUsdc === null) return null;
    const q = new URLSearchParams({
      agent: name,
      seller: one.sellerAddr,
      units: String(one.units),
      quote: String(one.quoteUsdc),
      chain,
    });
    if (one.indexId) q.set("index", one.indexId);
    return { url: `/api/float/classify?${q.toString()}`, quote: one.quoteUsdc };
  }

  function walk(from: number) {
    let i = from - 1;
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      i += 1;
      if (i > order.length - 1) {
        if (timer.current) clearInterval(timer.current);
        return;
      }
      setStep(i);
    }, STEP_MS);
  }

  async function run() {
    if (busy) return;
    const req = request();
    if (!req) {
      setGate({ at: "unreadable", reason: "this page cannot name every part of that payment" });
      return;
    }
    if (timer.current) clearInterval(timer.current);
    setGate({ at: "asking" });
    setStep(0);
    try {
      const r = await fetch(req.url);
      const j = await r.json();
      const d = j?.data;
      /* THE ANSWER MUST BE ABOUT THE QUESTION. `FloatVerdict` echoes the quote
         back for exactly this, and the chain stamp is checked because a raw
         fetch skips `fetcherFor`'s guard: one deployment serves both chains. */
      if (j?.chain !== chain || d?.quote_usdc !== req.quote) {
        setGate({ at: "unreadable", reason: "that answer was about a different question" });
        return;
      }
      if (d?.status !== "ok" || typeof d?.code !== "number") {
        setGate({ at: "unreadable", reason: d?.reason ?? "the chain did not answer" });
        return;
      }
      setStep(1);
      if (d.code !== 0) {
        setGate({ at: "refused", code: d.code, reason: String(d.chain_reason ?? "") });
        return;
      }
      setGate({ at: "allowed" });
      walk(2);
    } catch {
      setGate({ at: "unreadable", reason: "the chain could not be reached" });
    }
  }

  /* The flat diagram's own props, unchanged, so the fallback is the component
     that already works rather than a reduced copy of this one. */
  const flat =
    one.status === "live" ? (
      <MoneyPath
        fairUsdc={one.fairUsdc ?? undefined}
        jitFunded={one.jit}
        paying={paying}
        quoteUsdc={one.quoteUsdc ?? undefined}
        vault={vault}
      />
    ) : (
      <MoneyPath paying={paying} vault={vault} />
    );

  if (one.status === "reading") {
    return (
      <>
        {flat}
        <p className="label muted">
          <i aria-hidden className="dot breathe" />
          <Ed x="walking the newest payment's own logs" p="checking the latest payment" />
        </p>
      </>
    );
  }

  if (one.status === "scripted") {
    return (
      <>
        {flat}
        <div className="flow-controls">
          <span className="chip chip-sim chip-wrap">
            {one.why === "none-in-window" ? (
              <Ed
                x="this treasury has paid, but not inside the window the tape can read"
                p="this account has paid before, just not recently enough to show"
              />
            ) : (
              <Ed x="no payment on this chain yet" p="no payment here yet" />
            )}
          </span>
        </div>
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: "var(--t-4)", marginTop: 0, maxWidth: "var(--measure)" }}
          x="The shape above is the one the contract enforces, with no figures, because there is no payment yet to read them off."
          p="The picture above shows the steps, with no numbers, because there is no payment here yet to take numbers from."
        />
      </>
    );
  }

  return (
    <>
      {can ? (
        <Scene
          beats={one.beats}
          fairMatches={one.fairMatches}
          fairUsdc={one.fairUsdc}
          hovered={hop}
          human={one.human}
          jit={one.jit}
          label="one payment, plotted against its own log order, on three planes: the agent and the benchmark touch no money, the treasury and the sleeve and the seller are ours, and the Morpho vault in front is not ours and releases the shortfall first"
          lit={lit}
          onContextLost={lostContext}
          onHop={setHop}
          quoteUsdc={one.quoteUsdc}
          running={walking}
          treasury={vault.vault ?? null}
          venueLogs={one.venueLogs}
          venueReceiver={one.venueReceiver}
          venueShares={one.venueShares}
          venueUsdc={one.venueUsdc}
          verdict={one.verdict}
        />
      ) : (
        flat
      )}

      <div className="flow-controls">
        <button aria-pressed={busy} className={`chip${busy ? " chip-gold" : ""}`} onClick={run} type="button">
          {busy ? <i aria-hidden className="dot breathe" /> : null}
          <Ed x="Run this payment" p="Try this payment" />
        </button>
        {gate.at === "asking" ? (
          <span className="label muted">
            <Ed x="asking the chain whether it would be allowed now" p="asking the chain if it is allowed now" />
          </span>
        ) : gate.at === "refused" ? (
          /* THE VAULT'S OWN SENTENCE, UNREWORDED, and the rung it stopped at.
             Nothing downstream lights, because nothing moved. */
          <span className="chip chip-breach chip-wrap">
            <Ed x="refused at rung" p="stopped at step" /> <span className="num">{gate.code}</span>
            {gate.reason ? ` · ${gate.reason}` : ""}
          </span>
        ) : gate.at === "unreadable" ? (
          <span className="chip chip-sim chip-wrap">{gate.reason}</span>
        ) : gate.at === "allowed" ? (
          <span className="chip chip-teal chip-wrap">
            <Ed x="the chain allows it, so the money moves" p="the chain says yes, so the money moves" />
          </span>
        ) : null}
        <OrderChip verdict={one.verdict} />
        {one.human ? (
          <span className="chip chip-gold chip-wrap">
            <Ed x="a human released this one" p="a person approved this one" />
          </span>
        ) : null}
        {/* A GUEST BUDGET IS A DIFFERENT TRUST STORY, not a footnote: it is the
            fixed template the registrar may write and nothing else, issued
            against a verified human rather than configured per agent. */}
        {one.guest ? (
          <span className="chip chip-sky chip-wrap">
            <Ed x="spent from a guest budget, on the fixed template" p="spent from a visitor budget, on the standard limit" />
          </span>
        ) : null}
        {one.fairMatches === false ? (
          <span className="chip chip-breach chip-wrap">
            <Ed x="the recomputed fair total did not match the receipt" p="the fair price does not match the receipt" />
          </span>
        ) : one.fairMatches === null ? (
          <span className="chip chip-sim chip-wrap">
            <Ed x="the print it named could not be found, so the fair total is unchecked" p="we could not find the rate it used, so this is unchecked" />
          </span>
        ) : null}
        <TxLink explorer={explorer} txRef={one.tx} />
      </div>

      <div className="flow-log">
        <Ed x="asked" p="asked" />{" "}
        <span className="num">{one.quoteUsdc === null ? "…" : fmtPrice(one.quoteUsdc)}</span>{" "}
        <Ed x="against a fair total of" p="against a fair price of" />{" "}
        <span className="num">{one.fairUsdc === null ? "…" : fmtPrice(one.fairUsdc)}</span> USDC
        {one.premiumBps === null ? null : (
          <>
            {" · "}
            <span className="num">{one.premiumBps}</span> <Ed x="bp" p="bp" />
          </>
        )}
      </div>

      {/* WHAT WAS BOUGHT AND WHO WAS PAID. A price is not checkable against a
          benchmark without the thing it is the price OF, and this panel is about
          who touches the money, so the address that actually received it belongs
          on it. The seller here is the one THIS payment paid, which is not
          necessarily the seller the vault allowlists in the table below. */}
      <div className="flow-log">
        <Ed x="for" p="for" /> <span className="mono">{one.indexName ?? "…"}</span>
        {one.units === null ? null : (
          <>
            {" · "}
            <span className="num">{fmtInt(one.units)}</span> <Ed x="units" p="units" />
          </>
        )}
        {one.sellerAddr ? (
          <>
            {" · "}
            <Ed x="paid to" p="paid to" /> <AddressChip address={one.sellerAddr} explorer={explorer} />
          </>
        ) : null}
        {one.block === null ? null : (
          <>
            {" · "}
            <Ed x="in block" p="in block" /> <span className="num">{fmtInt(one.block)}</span>
          </>
        )}
      </div>

      {/* ONE DOCKED ROW, TWO SOURCES, AND NEVER A FLOATING TOOLTIP. The house
          rule is stated in `components/charts/useCrosshair.ts`: values print
          into a docked caption row, never a floating box. A hovered hop
          outranks the run's own narration while the pointer is on it, and
          `aria-live` means a change is announced rather than merely drawn. */}
      {hop !== null ? (
        <div aria-live="polite" className="flow-log" role="status">
          <span className="mono">{HOP_NAME[hop]}</span> {HOP_SAYS[hop]}
        </div>
      ) : step < 0 ? null : (
        <div aria-live="polite" className="flow-log" role="status">
          {step === 0 ? (
            <Ed x="the agent asks. Its own wallet holds nothing, now and at the end." p="the robot asks. Its own wallet is empty, now and after." />
          ) : step === 1 ? (
            gate.at === "refused" ? (
              <Ed x="the vault refused it, and moved nothing" p="the vault said no, and moved nothing" />
            ) : (
              <Ed x="the vault read the print and recomputed the fair total itself" p="the vault looked up the real rate and worked the total out itself" />
            )
          ) : order[step] === "venue" ? (
            <>
              <Ed x="Morpho released the shortfall, to the treasury directly" p="the savings provider sent the missing part, straight to the treasury" />
              {one.venueUsdc === null ? null : (
                <>
                  {": "}
                  <span className="num">{fmtPrice(one.venueUsdc)}</span> USDC
                </>
              )}
            </>
          ) : order[step] === "pull" ? (
            <Ed x="our sleeve recorded what the venue delivered" p="our savings wrapper recorded what arrived" />
          ) : order[step] === "pay" ? (
            <>
              <Ed x="the treasury paid the seller" p="the treasury paid the shop" />
              {one.quoteUsdc === null ? null : (
                <>
                  {" "}
                  <span className="num">{fmtPrice(one.quoteUsdc)}</span> USDC
                </>
              )}
            </>
          ) : (
            <Ed x="the receipt is written, and the agent's wallet still holds nothing." p="the receipt is written, and the robot still holds nothing." />
          )}
        </div>
      )}

      {/* EVERY HOP, WITH NO HOVER AT ALL. The tooltip is an enhancement; this
          is the path. It works on a phone, it works from a keyboard, it is
          what a reader gets when the flat SVG renders instead of the canvas,
          and it sits outside `role="img"` so it is actually in the
          accessibility tree. `.sheet` is the house table and needs nothing
          added to it. */}
      <div className="table-scroll">
        <table className="sheet">
          <thead>
            <tr>
              <th>
                <Ed x="Hop" p="Step" />
              </th>
              <th>
                <Ed x="What happens there" p="What happens" />
              </th>
            </tr>
          </thead>
          <tbody>
            {HOPS.map((h) => (
              <tr key={h.id}>
                <td className="mono">{HOP_NAME[h.id]}</td>
                <td>
                  {HOP_SAYS[h.id]}
                  {h.escalation && !one.human ? (
                    <>
                      {" "}
                      <span className="chip chip-sim chip-wrap">
                        <Ed x="not the lane this payment took" p="not what happened here" />
                      </span>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {can ? (
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: "var(--t-4)", marginTop: 0, maxWidth: "var(--measure)" }}
          x="Run asks the chain whether this quote would pass. Heights are the newest receipt's logs, and with no call trace their order is the only witness. Drag to look."
          p="Press Run and the chain says whether this payment is allowed. The steps after it come from a real payment’s record. Drag to turn it."
        />
      ) : null}

      <Narration tx={one.tx} />
    </>
  );
}
