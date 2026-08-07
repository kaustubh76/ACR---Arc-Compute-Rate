"use client";

import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { fmtInt, fmtPrice } from "@/lib/format";
import type { SeriesPoint } from "@/lib/types";

/* The estimator's work, hour by hour, as it happens.

   The Attack Lab could previously only ASSERT that the index resists
   manipulation: you pressed a button, a line stayed flat, and you took its
   word. Every number needed to show the resisting was computed twelve times a
   run and thrown away — the cleaning fraction, the observations kept, the
   sybil clusters found, the cost to move the print a basis point.

   So this is the receipt. Under attack the raw tape roughly quintuples while
   the observations that survive cleaning barely move: that gap IS the defence,
   and it is the one thing on this page a sceptic can check line by line.

   Deliberately no TxLink or AddressChip, unlike the venue tapes this borrows
   its vocabulary from — an attack run is a simulation and has no transaction.
   Implying otherwise would be the exact opposite of accountability. */

const SHOWN = 24; // same cap the settlement and futures tapes use

export function AttackTape({
  series,
  live,
  hoursTotal,
}: {
  series: SeriesPoint[];
  /** false → these are the archived exercise's hours, not a run happening now */
  live: boolean;
  hoursTotal: number;
}) {
  if (!series.length) {
    return (
      <div className="tape">
        <div className="tape-static">
          <span className="tape-item muted">
            <Ed
              x="no hours estimated yet — the tape fills one hour at a time once a run starts"
              p="nothing to show yet — this fills in one hour at a time once you start a run"
            />
          </span>
        </div>
      </div>
    );
  }

  // Newest first: during a run the hour that just landed is the interesting
  // one, and a reader should not have to scan to the bottom to find it.
  const rows = [...series].slice(-SHOWN).reverse();

  return (
    <>
      <div className="reading" aria-live="polite">
        <span className="muted">
          <Ed x="estimator log" p="what the maths did" />
        </span>
        <span>
          {fmtInt(series.length)}/{fmtInt(hoursTotal)} <Ed x="hours" p="hours" />
        </span>
        <span className={live ? "green" : "muted"}>
          {live ? (
            <Ed x="live" p="happening now" />
          ) : (
            <Ed x="archived exercise" p="a saved run" />
          )}
        </span>
      </div>
      <div className="tape">
        <div className="tape-static" style={{ display: "grid", gap: 2 }}>
          {rows.map((p) => {
            // n_raw/n_obs are optional: the bundled snapshot predates them, so
            // an archived hour renders what it has rather than "undefined".
            const kept = p.n_obs != null && p.n_raw != null;
            return (
              <span className="tape-item" key={p.hour}>
                <b className="seq">H{String(p.hour).padStart(2, "0")}</b>
                {p.attack ? (
                  <span className="chip chip-breach">
                    <Ed x="under attack" p="being cheated" />
                  </span>
                ) : null}
                <span className="muted">
                  <Ed x="true" p="real price" />
                </span>
                <span className="amt">{fmtPrice(p.true)}</span>
                <span className="muted">ACR</span>
                <span className="amt green">{fmtPrice(p.acr)}</span>
                <span className="muted">
                  ({fmtInt(p.acr_err_bp)} <Ed x="bp off" p="off" />)
                </span>
                <span className="muted">VWAP</span>
                <span className="amt vermilion">{fmtPrice(p.vwap)}</span>
                <span className="muted">({fmtInt(p.vwap_err_bp)} bp)</span>
                {kept ? (
                  <>
                    <span className="muted">·</span>
                    <span className="amt">
                      {fmtInt(p.n_obs as number)}/{fmtInt(p.n_raw as number)}
                    </span>
                    <span className="muted">
                      <Ed x="kept" p="kept" />
                    </span>
                    {p.cleaned_pct != null ? (
                      <span className={p.cleaned_pct > 80 ? "gold" : "muted"}>
                        {p.cleaned_pct.toFixed(1)}% <Ed x="cleaned" p="thrown out" />
                      </span>
                    ) : null}
                  </>
                ) : null}
                {p.sybil_clusters ? (
                  <span className="muted">
                    {p.sybil_clusters}{" "}
                    <Ed
                      x="sybil clusters"
                      p={<Term k="sybil">fake-identity rings</Term>}
                    />
                  </span>
                ) : null}
                {p.step_ms != null ? (
                  <span className="muted">{fmtInt(p.step_ms)}ms</span>
                ) : null}
              </span>
            );
          })}
        </div>
      </div>
    </>
  );
}
