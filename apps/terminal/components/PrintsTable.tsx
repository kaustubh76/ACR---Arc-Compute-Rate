"use client";

import { useRouter } from "next/navigation";
import { TickerNumber } from "./TickerNumber";
import { Ed } from "./Ed";
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
            <th>
              <Ed x="Rate (on-chain)" p="Official rate" />
            </th>
            <th>
              <Ed x="CI (bp)" p="Wiggle (bp)" />
            </th>
            <th>
              <Ed x="Est. (sim)" p="Our estimate" />
            </th>
            <th>
              <Ed x="$ / 1% move" p="Cost to bend 1%" />
            </th>
            <th>
              <Ed x="N" p="Payments" />
            </th>
            <th>
              <Ed x="Provenance" p="Where it lives" />
            </th>
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
                      <Ed
                        x={direct ? "⛓ direct read" : live ? "⛓ on-chain" : "⛓ archived"}
                        p={direct ? "⛓ read direct" : live ? "⛓ on the blockchain" : "⛓ saved copy"}
                      />
                    </span>
                  ) : (
                    <span className="muted">
                      <Ed x="sim" p="simulation" />
                    </span>
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
