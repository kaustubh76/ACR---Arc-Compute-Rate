"use client";

import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { fmtInt, fmtPrice } from "@/lib/format";
import type { SeriesPoint } from "@/lib/types";

/* The estimator's work, hour by hour, as it happens.

   The Attack Lab could previously only ASSERT that the index resists
   manipulation: you pressed a button, a line stayed flat, and you took its
   word. Every number needed to show the resisting was computed twelve times a
   run and thrown away: the cleaning fraction, the observations kept, the
   sybil clusters found, the cost to move the print a basis point.

   So this is the receipt. Under attack the raw tape roughly quintuples while
   the observations that survive cleaning barely move: that gap IS the defence,
   and it is the one thing on this page a sceptic can check line by line.

   It is a LEDGER, so it is a sheet table, not a tape. It first shipped wearing
   the settlement tape's marquee shell, which was wrong three ways: `.tape`
   paints 60px gradient veils down both edges to fade a scrolling track, in a
   navy the adversary room never re-tints; `.tape-static` carries its own
   horizontal scrollbar; and sixteen nowrap inline spans per row cannot fit the
   stage column, so every row ran off the right edge under the veil. Eight
   columns of tabular numbers is a table. Being one also aligns the hours down
   the page, which is the whole point of a log you read for a trend.

   Deliberately no TxLink or AddressChip, unlike the venue tapes it used to
   borrow from: an attack run is a simulation and has no transaction. Implying
   otherwise would be the exact opposite of accountability. */

const SHOWN = 12; // one full exercise window; the rest is behind the toggle

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
      <p className="muted" style={{ fontSize: 13, marginTop: 12, maxWidth: 68 * 9 }}>
        <Ed
          x="No hours estimated yet. The log fills one hour at a time once a run starts."
          p="Nothing to show yet. This fills in one hour at a time once you start a run."
        />
      </p>
    );
  }

  // Newest first: during a run the hour that just landed is the interesting
  // one, and a reader should not have to scan to the bottom to find it.
  const rows = [...series].slice(-SHOWN).reverse();
  // Every archived hour predating the telemetry lacks these, so the columns are
  // drawn only when at least one row can fill them.
  const hasCounts = rows.some((p) => p.n_obs != null && p.n_raw != null);
  const hasClusters = rows.some((p) => p.sybil_clusters);
  const hasStep = rows.some((p) => p.step_ms != null);

  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-head" style={{ marginTop: 0 }}>
        <span className="label">
          <Ed x="estimator log" p="what the maths did" />
        </span>
        <span className="label">
          <span className="muted">
            {fmtInt(series.length)}/{fmtInt(hoursTotal)} <Ed x="hours" p="hours" />
          </span>{" "}
          <span className={live ? "green" : "muted"}>
            {live ? <Ed x="· live" p="· happening now" /> : <Ed x="· archived" p="· a saved run" />}
          </span>
        </span>
      </div>

      <div className="table-scroll">
        <table className="sheet">
          <thead>
            <tr>
              <th>
                <Ed x="hour" p="hour" />
              </th>
              <th>
                <Ed x="true" p="real price" />
              </th>
              <th>ACR</th>
              <th>
                <Ed x="ACR err" p="ACR off by" />
              </th>
              <th>VWAP</th>
              <th>
                <Ed x="VWAP err" p="average off by" />
              </th>
              {hasCounts ? (
                <>
                  <th>
                    <Ed x="kept / raw" p="kept of seen" />
                  </th>
                  <th>
                    <Ed x="cleaned" p="thrown out" />
                  </th>
                </>
              ) : null}
              {hasClusters ? (
                <th>
                  <Ed x="sybil clusters" p={<Term k="sybil">fake rings</Term>} />
                </th>
              ) : null}
              {hasStep ? <th>ms</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.hour}>
                <td className="mono">
                  H{String(p.hour).padStart(2, "0")}
                  {p.attack ? (
                    <span className="vermilion">
                      {" "}
                      <Ed x="under attack" p="being cheated" />
                    </span>
                  ) : null}
                </td>
                <td className="mono">{fmtPrice(p.true)}</td>
                <td className="mono green">{fmtPrice(p.acr)}</td>
                <td className="mono green">{fmtInt(p.acr_err_bp)} bp</td>
                <td className="mono vermilion">{fmtPrice(p.vwap)}</td>
                <td className="mono vermilion">{fmtInt(p.vwap_err_bp)} bp</td>
                {hasCounts ? (
                  <>
                    <td className="mono">
                      {p.n_obs != null && p.n_raw != null
                        ? `${fmtInt(p.n_obs)} / ${fmtInt(p.n_raw)}`
                        : "…"}
                    </td>
                    <td className={`mono ${p.cleaned_pct != null && p.cleaned_pct > 80 ? "gold" : ""}`}>
                      {p.cleaned_pct != null ? `${p.cleaned_pct.toFixed(1)}%` : "…"}
                    </td>
                  </>
                ) : null}
                {hasClusters ? <td className="mono">{p.sybil_clusters || "0"}</td> : null}
                {hasStep ? (
                  <td className="mono">{p.step_ms != null ? fmtInt(p.step_ms) : "…"}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
