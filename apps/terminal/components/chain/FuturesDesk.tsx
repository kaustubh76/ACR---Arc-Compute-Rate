"use client";

import { AddressChip } from "@/components/chain/AddressChip";
import { Sparkline } from "@/components/charts/Sparkline";
import { TickerNumber } from "@/components/TickerNumber";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { chainFacts } from "@/lib/chain";
import { serviceName } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import type { ChainFactsData, FuturesDeskRow, FuturesTradeRow } from "@/lib/types";

/* The live on-chain futures desk: the maker's book (inventory + mark-to-oracle
   PnL) and settlement status, read from ACRFutures. This is the pillar-4
   instrument layer *trading*, not just quoted — values tick/flash on change, a
   heartbeat marks it live, the expiry counts down, and a sparkline shows the
   book breathing. Degrades honestly: no venue → says so; archived → static. */

function usd(n: number): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function countdown(expiryTs: number, nowS: number): string {
  const d = expiryTs - nowS;
  if (d <= 0) return "expired";
  const days = Math.floor(d / 86400);
  const hrs = Math.floor((d % 86400) / 3600);
  const mins = Math.floor((d % 3600) / 60);
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  const secs = Math.floor(d % 60);
  return `${mins}m ${secs}s`;
}

/** Reconstruct the maker's recent inventory path from the trade tape, anchored
 *  at the current on-chain inventory (maker changes by −qty on each taker fill).
 *  Oldest → newest, so the sparkline reads left-to-right. */
function inventoryPath(current: number, trades: FuturesTradeRow[], seriesId: number): number[] {
  const rel = trades.filter((t) => t.series_id === seriesId).slice(0, 24);
  const path = [current];
  let inv = current;
  for (const t of rel) {
    inv = inv + t.qty; // undo this fill (maker moved by −qty)
    path.push(inv);
  }
  return path.reverse();
}

export function FuturesDesk({
  desks,
  trades,
  chain,
  live,
}: {
  desks: Record<string, FuturesDeskRow> | undefined;
  trades?: FuturesTradeRow[];
  chain: ChainFactsData | null | undefined;
  live: boolean;
}) {
  const now = useNow();
  const nowS = now > 0 ? now : Date.now() / 1000;
  const rows = Object.values(desks ?? {});
  const cf = chainFacts(chain);
  const venue = cf.futures;
  const explorer = cf.explorer;
  const primary = rows[0];
  const spark = primary ? inventoryPath(primary.maker_inventory, trades ?? [], primary.series_id) : [];

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">
          <Ed x="The desk — on-chain futures (ACRFutures)" p="The trading desk — real futures on the blockchain" />
        </span>
        {venue ? (
          rows.length && live ? (
            <span className="chip chip-teal">
              <span className="dot breathe" aria-hidden />
              <Ed x="live · settles vs ACROracle" p="live · pays out against the official rate" />
            </span>
          ) : (
            <span className="chip chip-gold">
              <Ed x="venue deployed · loads live" p="market open · loading" />
            </span>
          )
        ) : (
          <span className="chip chip-sim">
            <Ed x="venue not yet deployed" p="market not open yet" />
          </span>
        )}
      </div>

      {rows.length ? (
        <>
          <div className="table-scroll">
            <table className="sheet">
              <thead>
                <tr>
                  <th>Index</th>
                  <th>
                    <Ed x="Maker book" p="Dealer’s position" />
                  </th>
                  <th>
                    <Ed x="Open interest" p="Contracts open" />
                  </th>
                  <th>
                    <Ed x="Unrealized" p="Paper P&L" />
                  </th>
                  <th>
                    <Ed x="Expiry" p="Settles in" />
                  </th>
                  <th>
                    <Ed x="Traders" p="Players" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const flat = Math.abs(r.maker_inventory) < 1e-9;
                  const side = r.maker_inventory > 0 ? "long" : "short";
                  return (
                    <tr key={r.index_id}>
                      <td className="gold" style={{ fontWeight: 600 }}>
                        {r.index_id} <span className="muted">· {serviceName(r.index_id)}</span>
                      </td>
                      <td className="mono">
                        {flat ? (
                          <span className="muted">flat</span>
                        ) : (
                          <>
                            <TickerNumber
                              text={`${r.maker_inventory > 0 ? "+" : "−"}${Math.abs(r.maker_inventory).toFixed(1)}`}
                            />{" "}
                            <span className="muted">{side}</span>
                          </>
                        )}
                      </td>
                      <td className="mono">
                        <TickerNumber text={r.open_interest.toFixed(1)} />
                      </td>
                      <td className="mono">
                        <TickerNumber
                          text={usd(r.maker_unrealized_usdc)}
                          className={r.maker_unrealized_usdc >= 0 ? "green" : "vermilion"}
                        />
                      </td>
                      <td className="mono">
                        {r.settled ? (
                          <span className="muted">settled @ {r.settlement_price.toFixed(5)}</span>
                        ) : (
                          countdown(r.expiry_ts, nowS)
                        )}
                      </td>
                      <td className="mono">
                        <TickerNumber text={String(r.trader_count)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {spark.length > 1 ? (
            <div className="desk-spark">
              <span className="reading" style={{ justifyContent: "flex-start" }}>
                <Ed x="maker book · recent fills" p="dealer’s position · recent trades" />
              </span>
              <Sparkline values={spark} height={30} />
            </div>
          ) : null}
        </>
      ) : (
        <div className="awaiting">
          {venue ? (
            <Ed
              x="The desk is deployed — positions load once the venue warms."
              p="The market is open — trades load once the venue warms."
            />
          ) : (
            <Ed
              x="The futures venue opens when ACRFutures is deployed (ACR_FUTURES_ADDRESS)."
              p="The futures market opens once the trading contract is deployed."
            />
          )}
        </div>
      )}

      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 13, marginTop: 16, maxWidth: 68 * 9 }}
        x={
          <>
            Every taker fill is mirrored by the maker, so the book nets to zero; at expiry each
            position <Term k="cash-settled">cash-settles</Term> against{" "}
            <span className="mono">ACROracle.latestPrint</span> on-chain — no delivery, no seller
            cooperation. The tape above is live on-chain fills; the term structure skews around this
            exact inventory.
            {venue ? (
              <>
                {" "}
                Venue <AddressChip address={venue} explorer={explorer} copy={false} />.
              </>
            ) : null}
          </>
        }
        p={
          <>
            Every buy is matched by the dealer, so the book always balances; at the deadline each
            contract pays out in cash against the official on-chain rate — no delivery, no seller
            needed. The tape above is real trades; the price corridor leans with whatever the dealer
            is holding.
            {venue ? (
              <>
                {" "}
                Contract <AddressChip address={venue} explorer={explorer} copy={false} />.
              </>
            ) : null}
          </>
        }
      />
    </section>
  );
}
