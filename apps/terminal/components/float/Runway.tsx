"use client";

import { useState } from "react";

import { Ed } from "@/components/Ed";
import { TickerNumber } from "@/components/TickerNumber";
import type { FloatPrint, FloatVaultState } from "@/lib/float";
import { cheapest, scaledPrice, toUnits, tokensFor, wad } from "@/lib/floatRunway";
import { fmtInt, fmtPrice } from "@/lib/format";

/* Runway, in compute.

   THE DENOMINATOR IS THE PRODUCT. A treasury counted in dollars does not know
   what it can afford to DO, and that sentence is the reason this panel is
   ranked first in the dashboard spec. So the figure is tokens: the unit a print
   is actually priced in.

   NOT CALLS, THOUGH THE SPEC SAYS CALLS. `float/app/index.html` already refused
   that unit in its own comment — "calling it 'a call' would be inventing a call
   size nobody quoted" — and the `float_runway` MCP tool says the same. Nobody
   has measured a call size, so naming one here would be the only invented
   number on the page.

   NO DAYS EITHER. The spec defines days as buffer over forecast, and a forecast
   needs a spend rate, which needs receipt timestamps this surface does not
   read. The alternative is a block-count estimate, which `float/src/bin/keeper.ts`
   records as the exact bug it had to fix. Tokens are free and exact.

   THE SLIDER IS LABELLED "what-if" BECAUSE IT IS ONE. It moves the price
   locally and recomputes; it changes nothing on chain and nothing about what
   the treasury actually holds. */

const PRICE_MIN = 25;
const PRICE_MAX = 300;
const CHAIN_PRICE = 100;

/** The model, as the store names itself, minus the index prefix. Data rather
 *  than copy: the chain supplies the string. */
function modelOf(p: FloatPrint): string {
  return p.name.replace(/^ACR-INF:/, "") || p.index.slice(0, 10);
}

function PriceRow({
  p,
  totalUnits,
  factorPct,
  isCheapest,
}: {
  p: FloatPrint;
  totalUnits: bigint;
  factorPct: number;
  isCheapest: boolean;
}) {
  const base = wad(p.price_wad);
  const moved = base === null ? null : scaledPrice(base, factorPct);
  const tokens = moved === null ? null : tokensFor(totalUnits, moved);

  return (
    <div className="fact">
      <p className="fact-value">
        {tokens === null ? (
          <span className="num">…</span>
        ) : (
          /* `quiet`, deliberately. TickerNumber's flash means "this just
             updated", and a reader dragging the what-if slider is changing the
             number themselves rather than watching the chain change it. */
          <TickerNumber className="num" quiet text={fmtInt(Number(tokens))} />
        )}{" "}
        <span className="label">
          <Ed x="tokens" p="tokens" />
        </span>
      </p>
      <p className="fact-gloss mono">{modelOf(p)}</p>
      <p className="label mono">
        <span className="num">{moved === null ? "…" : fmtPrice(Number(moved) / 1e18)}</span>{" "}
        <Ed x="per 1k tokens" p="for every 1,000" />
        {p.ci_bps > 0 ? (
          <>
            {" · ± "}
            <span className="num">{(p.ci_bps / 100).toFixed(1)}</span>
            {"%"}
          </>
        ) : null}
      </p>
      <p className="label">
        {isCheapest ? (
          <span className="chip chip-teal">
            <Ed x="cheapest priced" p="the cheapest one" />
          </span>
        ) : null}
        {p.stale ? (
          <span className="chip chip-sim">
            <Ed x="print is stale" p="this rate is old" />
          </span>
        ) : null}
      </p>
    </div>
  );
}

export function Runway({ vault }: { vault: FloatVaultState }) {
  const [factorPct, setFactorPct] = useState(CHAIN_PRICE);

  const prints = vault.prints ?? [];
  const priced = prints.filter((p) => wad(p.price_wad) !== null);
  const totalUnits = toUnits(vault.total_usdc ?? 0);
  const best = cheapest(priced);
  const hours = vault.policy?.buffer_hours;

  return (
    <section className="section anchor-target" id="runway">
      <div className="section-head">
        <h2 className="label">
          <Ed x="Runway, in compute" p="What the money buys" />
        </h2>
        <span className="label">
          {factorPct === CHAIN_PRICE ? (
            <span className="chip chip-teal">
              <Ed x="at the chain's own prints" p="at today's real rates" />
            </span>
          ) : (
            <span className="chip chip-gold">
              <Ed x="what-if" p="what-if" />
            </span>
          )}
        </span>
      </div>

      <Ed
        as="p"
        className="muted"
        style={{ fontSize: "var(--t-4)", marginTop: 0, maxWidth: "var(--measure)" }}
        x="A treasury counted in dollars does not know what it can afford to do. These are the tokens this one could buy at each model's own on-chain price, which is the number an agent planning a long job actually needs."
        p="A pot of money does not tell you what you can do with it. This is how much work it buys at today's real prices."
      />

      {totalUnits === null || totalUnits === 0n ? (
        <p className="muted awaiting">
          <Ed x="the treasury is empty, so there is no runway to show." p="the treasury is empty, so there is nothing to show." />
        </p>
      ) : priced.length === 0 ? (
        <p className="muted awaiting">
          <Ed x="no price yet, so no runway. The keeper has not printed one." p="no rate yet, so nothing to show yet." />
        </p>
      ) : (
        <>
          <div className="facts">
            {priced.map((p) => (
              <PriceRow
                factorPct={factorPct}
                isCheapest={best?.index === p.index}
                key={p.index}
                p={p}
                totalUnits={totalUnits}
              />
            ))}
          </div>

          <div className="flow-controls">
            <label className="label">
              <Ed x="what-if: move the price" p="what-if: move the price" />{" "}
              <input
                aria-label="what-if price, as a percentage of the chain's own print"
                max={PRICE_MAX}
                min={PRICE_MIN}
                onChange={(e) => setFactorPct(Number(e.target.value))}
                step={5}
                type="range"
                value={factorPct}
              />{" "}
              <b className="gold mono">{factorPct}%</b>
            </label>
            {factorPct === CHAIN_PRICE ? null : (
              <button className="chip" onClick={() => setFactorPct(CHAIN_PRICE)} type="button">
                <Ed x="back to the chain's price" p="back to the real price" />
              </button>
            )}
          </div>

          <Ed
            as="p"
            className="muted"
            style={{ fontSize: "var(--t-3)", marginTop: "var(--s-3)", maxWidth: "var(--measure)" }}
            x="The slider is local. It recomputes what the treasury would buy if compute cost more or less, and changes nothing on chain and nothing about what is actually held."
            p="The slider only changes this page. It does not move any money or any real price."
          />
        </>
      )}

      {hours ? (
        <p className="label mono">
          <Ed x="policy keeps" p="the rules keep" /> <span className="num">{hours}</span>{" "}
          <Ed x="hours of forecast spend liquid" p="hours of spending ready to go" />
        </p>
      ) : null}
    </section>
  );
}
