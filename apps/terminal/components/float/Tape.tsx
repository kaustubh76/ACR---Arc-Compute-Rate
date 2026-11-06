"use client";

import { Ed } from "@/components/Ed";
import { TxLink } from "@/components/chain/TxLink";
import type { FloatTapeRow } from "@/lib/float";
import { fmtInt, fmtPrice } from "@/lib/format";
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

function Row({ r }: { r: FloatTapeRow }) {
  const paid = r.kind === "paid";
  return (
    <tr>
      <td className="mono">
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
        <TxLink txRef={r.tx} />
      </td>
    </tr>
  );
}

export function Tape() {
  const { tape } = useFloatTape();
  const data = tape?.data ?? null;
  const live = Boolean(tape?.live);
  const rows = data?.rows ?? [];

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
          x="Nothing was paid or refused inside the window below. That is a fact about the window, not about the treasury, which is why the window is printed rather than left to be guessed at."
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
              {rows.map((r) => (
                <Row key={`${r.tx}-${r.kind}-${r.id ?? r.code}-${r.block}`} r={r} />
              ))}
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
