"use client";

import { useRouter } from "next/navigation";
import { TickerNumber } from "./TickerNumber";
import { ciWidthBp, fmt, fmtInt, heroFigure, money } from "@/lib/format";
import type { PrintRow } from "@/lib/types";

export function PrintsTable({
  prints,
  live = false,
  direct = false,
}: {
  prints: PrintRow[];
  live?: boolean;
  /** on-chain blocks are fresh DIRECT ACROracle reads (press down) */
  direct?: boolean;
}) {
  const router = useRouter();
  return (
    <div className="table-scroll">
      <table className="sheet">
        <thead>
          <tr>
            <th>Index</th>
            <th>Rate (on-chain)</th>
            <th>CI (bp)</th>
            <th>Est. (sim)</th>
            <th>$ / 1% move</th>
            <th>N</th>
            <th>Provenance</th>
          </tr>
        </thead>
        <tbody>
          {prints.map((p) => {
            // Rate leads with the settlement-grade on-chain print; sim est. sits beside it.
            const h = heroFigure(p);
            return (
              <tr
                key={p.index_id}
                className="row-link"
                role="link"
                tabIndex={0}
                aria-label={`open the ${p.index_id} index page`}
                onClick={() => router.push(`/index/${p.index_id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    router.push(`/index/${p.index_id}`);
                  }
                }}
              >
                <td className="gold" style={{ fontWeight: 600 }}>
                  {p.index_id}
                </td>
                <td>
                  <TickerNumber text={fmt(h.value)} />
                </td>
                <td className="muted">{ciWidthBp(h).toFixed(1)}</td>
                <td className="muted">{fmt(p.value)}</td>
                <td className="vermilion">
                  <TickerNumber text={money(p.cost_to_move_1pct)} />
                </td>
                <td>{fmtInt(p.n_obs)}</td>
                <td>
                  {p.onchain ? (
                    <span className={live || direct ? "green" : "muted"}>
                      {direct ? "⛓ direct read" : live ? "⛓ on-chain" : "⛓ archived"}
                    </span>
                  ) : (
                    <span className="muted">sim</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
