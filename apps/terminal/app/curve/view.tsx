"use client";

import { QuoteCorridor } from "@/components/charts/QuoteCorridor";
import { useConnection } from "@/lib/useConnection";
import { fmt, serviceName } from "@/lib/format";
import type { Envelope, TerminalData } from "@/lib/types";

/* Curve data is maker quotes the oracle does NOT publish — there is no
   honest direct-read overlay. Off the live tier the page says exactly what
   the corridor is (last-known quotes) instead of pretending. */
function tierBanner(state: string, ageS: number | null, wakeRemainingS: number | null) {
  switch (state) {
    case "live":
    case "linking":
      return null;
    case "stale":
      return `last live quotes · ${ageS ?? 0}s ago — retrying`;
    case "waking":
      return `press waking · ~${wakeRemainingS ?? 0}s — quotes are last-known until it answers`;
    case "onchain-only":
      return "spot reads direct from ACROracle · the quotes below are last-known (the maker lives in the press)";
    default:
      return "archived quotes — the corridor re-opens with the live index API";
  }
}

export function CurveView({ initial }: { initial: Envelope<TerminalData> }) {
  const conn = useConnection(initial);
  const env = conn.env;
  const prints = Object.values(env.data.prints).filter((p) => p.curve?.length);
  const banner = tierBanner(conn.state, conn.ageS, conn.wakeRemainingS);

  return (
    <>
      <div className="standfirst-block" style={{ marginTop: 40 }}>
        <p className="standfirst" style={{ margin: 0 }}>
          Machine commerce now has a forward curve — weekly tenors, quoted continuously,
          cash-settled against the oracle print.
        </p>
      </div>

      <section className="section">
        <div className="section-head">
          <span className="label">The quote corridor — where the maker trades</span>
          {banner ? (
            <span className="chip chip-gold" title="the connection ladder's honest word on these quotes">
              {banner}
            </span>
          ) : null}
        </div>
        <QuoteCorridor prints={env.data.prints} />
      </section>

      <section className="section">
        <div className="section-head">
          <span className="label">Quotes</span>
        </div>
        <div className="table-scroll">
          <table className="sheet">
            <thead>
              <tr>
                <th>Index</th>
                <th>Tenor</th>
                <th>Bid</th>
                <th>Mid</th>
                <th>Ask</th>
                <th>Spread (bp)</th>
              </tr>
            </thead>
            <tbody>
              {prints.flatMap((p) =>
                p.curve.map((c) => (
                  <tr key={`${p.index_id}-${c.tenor_weeks}`}>
                    <td className="gold" style={{ fontWeight: 600 }}>
                      {p.index_id} <span className="muted">· {serviceName(p.index_id)}</span>
                    </td>
                    <td>{c.tenor_weeks}W</td>
                    <td>{fmt(c.bid)}</td>
                    <td style={{ fontWeight: 600 }}>{fmt(c.mid)}</td>
                    <td>{fmt(c.ask)}</td>
                    <td className="muted">{c.spread_bp.toFixed(1)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 16, maxWidth: 68 * 9 }}>
          Quotes by an Avellaneda–Stoikov market maker against the latest print — the corridor’s
          width is set by realized vol, its mid pinned to spot at zero inventory. The ACR-Weekly
          future cash-settles against <span className="mono">ACROracle</span> at expiry, 1,000 USDC
          per unit.
        </p>
      </section>
    </>
  );
}
