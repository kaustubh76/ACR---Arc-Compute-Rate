"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import { Ed } from "@/components/Ed";
import { AddressChip } from "@/components/chain/AddressChip";
import { MoneyPath } from "@/components/float/MoneyPath";
import { TxLink } from "@/components/chain/TxLink";
import type { FloatVaultState } from "@/lib/float";
import { fmtInt, fmtPrice } from "@/lib/format";
import { CHAINS } from "@/lib/chainChoice";
import { useChain } from "@/lib/useChain";
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
  const [lost, setLost] = useState(false);
  const lostContext = useCallback(() => setLost(true), []);
  const can = useCanRender(lost);
  /* THE EXPLORER OF THE CHAIN BEING SERVED. `TxLink` defaults to mainnet's
     while this vault lives on one chain, which is how every testnet receipt
     on the tape once deep-linked into an explorer that had never seen it.
     The same trap, the same fix (components/float/Tape.tsx:122-131). */
  const explorer = CHAINS[useChain()].profile.explorer;

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
          x="The shape above is the one the contract enforces, with no figures in it, because there is no payment here to read figures off. The moving version arrives with the first receipt."
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
          jit={one.jit}
          label="one payment, plotted against its own log order: the agent instructs and holds nothing, the benchmark checks the price, the shortfall leaves the yield venue, then the seller is paid"
          onContextLost={lostContext}
          quoteUsdc={one.quoteUsdc}
          verdict={one.verdict}
        />
      ) : (
        flat
      )}

      <div className="flow-controls">
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

      {can ? (
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: "var(--t-4)", marginTop: 0, maxWidth: "var(--measure)" }}
          x="Height is the log's position inside this one transaction, and the gaps are the real gaps. That is the whole proof: Arc serves no call trace, so the order of the logs in one receipt is the only witness that the shortfall left the yield venue before the seller was paid. Drag to check it from another angle. The agent sits behind the money plane on a dashed tether and holds nothing at either end."
          p="Height is where each step comes in the payment’s own record. That order proves savings moved before the shop was paid. Drag to turn it."
        />
      ) : null}

      <Narration tx={one.tx} />
    </>
  );
}
