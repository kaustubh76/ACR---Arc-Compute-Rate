"use client";

import { Fragment, useEffect, useRef, useState } from "react";

import { Ed } from "@/components/Ed";
import { CHAINS } from "@/lib/chainChoice";
import { TxLink } from "@/components/chain/TxLink";
import type { FloatTapeRow } from "@/lib/float";
import { fmtInt, fmtPrice } from "@/lib/format";
import { Walk } from "@/components/float/Walk";
import { useChain } from "@/lib/useChain";
import { useFloatTape } from "@/lib/useLive";

/* Every payment and every refusal, side by side.

   BOTH EVENTS OR NEITHER. A tape of `Receipt` alone would describe a treasury
   that has never turned anything down, which is the opposite of the claim this
   product makes. `Denied` carries the chain's own sentence AND the recomputed
   fair price, so a refusal here can say what the thing should have cost rather
   than only that it was blocked.

   THE WINDOW IS STATED, NOT IMPLIED. Arc refuses a log query wider than about
   ten thousand blocks, so this is the most recent slice. An empty tape over a
   named window is a fact a reader can act on; an empty tape over an unstated
   one is a treasury that looks idle and is not.

   A NEGATIVE PREMIUM IS A REAL ANSWER. `premiumBps` is signed on chain because
   a quote below fair is legal, so the sign is carried through rather than
   dropped into an absolute value that would read a bargain as an overcharge. */

/** The premium as a percentage, signed, or an ellipsis when there was no fair
 *  price to compare against. Percent and not basis points for the reason the
 *  rest of this surface gives: the policy is written in bp and a reader reads
 *  percent, and carrying both in one row is a mistake already made once here. */
function premium(row: FloatTapeRow): string {
  if (row.premium_bps === null) return "…";
  const pct = row.premium_bps / 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

/* One tape row. `useChain` rather than a prop threaded from `Tape`: the row is
   already a client component and the read is a context plus an external store,
   which is cheaper than another prop on a list this shape. */
function Row({
  r,
  open,
  onToggle,
  fresh,
}: {
  r: FloatTapeRow;
  open: boolean;
  onToggle: () => void;
  fresh: boolean;
}) {
  const explorer = CHAINS[useChain()].profile.explorer;
  const paid = r.kind === "paid";
  /* ONLY A PAYMENT CAN BE WALKED. A refusal moved no money, so there is no
     pull, no transfer and no order to show; `walk.html` refuses one by name
     for the same reason. Making the row look openable would promise a story
     that does not exist. */
  const canOpen = paid;

  return (
    <Fragment>
      <tr
        aria-expanded={canOpen ? open : undefined}
        className={`${canOpen ? "row-link" : ""}${fresh ? " tick-flash" : ""}`}
        onClick={canOpen ? onToggle : undefined}
        onKeyDown={
          canOpen
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
        role={canOpen ? "button" : undefined}
        tabIndex={canOpen ? 0 : undefined}
      >
        <td className="mono">
          {/* The caret carries no muted class: `app/developers/view.tsx`
              records the lesson that the one interactive glyph in a row must
              not be its lowest-contrast character. `aria-hidden` because
              `aria-expanded` already says the state. */}
          {canOpen ? <span aria-hidden>{open ? "▾ " : "▸ "}</span> : null}
          <span className={`chip ${paid ? "chip-teal" : "chip-breach"}`}>
            {paid ? <Ed x="paid" p="paid" /> : <Ed x="refused" p="refused" />}
          </span>
        </td>
        <td className="mono num">{paid && r.id ? fmtInt(r.id) : r.code ? fmtInt(r.code) : "…"}</td>
        <td className="mono num">{fmtPrice(r.quote_usdc)}</td>
        <td className="mono num">{r.fair_usdc > 0 ? fmtPrice(r.fair_usdc) : "…"}</td>
        {/* Shown on BOTH outcomes. A refusal's overcharge is the number the
            contract keeps `fair` on the event for, and printing an ellipsis
            there wasted the most damning figure on the page. */}
        <td className={`mono num${(r.premium_bps ?? 0) > 0 ? " vermilion" : ""}`}>{premium(r)}</td>
        <td className="wrap">
          {paid ? (
            <>
              {r.jit_funded ? (
                <span className="chip chip-gold">
                  <Ed x="pulled from yield" p="taken from savings" />
                </span>
              ) : null}
              {r.guest ? (
                <span className="chip chip-sky">
                  <Ed x="guest" p="a visitor" />
                </span>
              ) : null}
              {r.human_approved ? (
                <span className="chip chip-gold">
                  <Ed x="a person cleared it" p="a person said yes" />
                </span>
              ) : null}
            </>
          ) : (
            <span className="mono">{r.reason}</span>
          )}
        </td>
        <td className="mono">
          {/* THE EXPLORER OF THE CHAIN BEING SERVED. `TxLink` defaults to
              `CHAIN.explorer`, which is MAINNET's, while this vault is
              deployed to one chain and the tape only ever renders there. Every
              receipt was therefore deep-linking a testnet hash into a mainnet
              explorer, where it does not exist: a judge clicking the proof got
              nothing. The default is right for the rest of the terminal and
              wrong for exactly this panel. */}
          <TxLink explorer={explorer} txRef={r.tx} />
        </td>
      </tr>
      {canOpen && open ? (
        <tr>
          <td colSpan={7} style={{ textAlign: "left", padding: 0 }}>
            <Walk tx={r.tx} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

export function Tape() {
  const { tape } = useFloatTape();
  const data = tape?.data ?? null;
  const live = Boolean(tape?.live);
  const rows = data?.rows ?? [];

  /* One row open at a time. Several open at once turns a tape into a wall and
     each one costs a transaction read; a reader comparing two payments can
     open them in turn. */
  const [open, setOpen] = useState<string | null>(null);

  /* WHAT ARRIVED SINCE THE LAST POLL. Nothing on this page watched a polled
     list for a new row, so a receipt that landed between two twelve-second
     polls simply appeared, silently, at the top. `.tick-flash` is the gold
     newswire flash `TickerNumber` already uses for the same meaning, and it is
     already in the stylesheet's reduced-motion kill list.

     Keyed on the newest row's own transaction rather than on the row count: a
     tape that drops an old row while gaining a new one keeps the same length. */
  const newest = rows[0]?.tx ?? null;
  const seen = useRef<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  useEffect(() => {
    if (!newest) return;
    /* The first answer is not an arrival. Flashing it would greet every
       visitor with news of something that happened before they got here. */
    if (seen.current === null) {
      seen.current = newest;
      return;
    }
    if (seen.current === newest) return;
    seen.current = newest;
    setFresh(newest);
    const t = setTimeout(() => setFresh(null), 1_400);
    return () => clearTimeout(t);
  }, [newest]);

  return (
    <section className="section anchor-target" id="tape">
      <div className="section-head">
        <h2 className="label">
          <Ed x="Every payment, and every refusal" p="What it paid, and what it would not" />
        </h2>
        <span className="label">
          {data?.partial ? (
            <span className="chip chip-sim">
              <Ed x="the chain is busy; this slice is short" p="the chain is busy, so this list is short" />
            </span>
          ) : live ? (
            <span className="chip chip-teal">
              <i className="dot breathe" aria-hidden />
              <Ed x="read from the chain" p="read from the chain" />
            </span>
          ) : null}
        </span>
      </div>

      {!live ? (
        <p className="muted awaiting">
          <Ed x="reading the treasury's record." p="reading the treasury's record." />
        </p>
      ) : rows.length === 0 ? (
        <Ed
          as="p"
          className="muted"
          style={{ maxWidth: "var(--measure)" }}
          x="Nothing was paid or refused inside the window below. That is a fact about the window, not the treasury, which is why the window is printed."
          p="Nothing happened in the window below. That is about the window, not about the treasury."
        />
      ) : (
        <div className="table-scroll">
          <table className="sheet">
            <thead>
              <tr>
                <th>
                  <Ed x="Outcome" p="What happened" />
                </th>
                <th>
                  <Ed x="Receipt / rung" p="Number" />
                </th>
                <th>
                  <Ed x="Quote" p="Asked for" />
                </th>
                <th>
                  <Ed x="ACR fair" p="Fair price" />
                </th>
                <th>
                  <Ed x="Over fair" p="Above fair" />
                </th>
                <th>
                  <Ed x="What the chain said" p="What the chain said" />
                </th>
                <th>
                  <Ed x="Tx" p="Proof" />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const key = `${r.tx}-${r.kind}-${r.id ?? r.code}-${r.block}`;
                return (
                  <Row
                    fresh={fresh === r.tx}
                    key={key}
                    onToggle={() => setOpen(open === key ? null : key)}
                    open={open === key}
                    r={r}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data?.window_blocks ? (
        <p className="label mono">
          <Ed x="the most recent" p="the most recent" /> <span className="num">{fmtInt(data.window_blocks)}</span>{" "}
          <Ed x="blocks, ending at" p="blocks, up to block" />{" "}
          <span className="num">{fmtInt(data.to_block ?? 0)}</span>
        </p>
      ) : null}
    </section>
  );
}
