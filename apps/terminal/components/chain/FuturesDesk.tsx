"use client";

import { AddressChip } from "@/components/chain/AddressChip";
import { Sparkline } from "@/components/charts/Sparkline";
import { TickerNumber } from "@/components/TickerNumber";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { chainFacts } from "@/lib/chain";
import { serviceName } from "@/lib/format";
import { contractNotional, deskTier, expiryLabel } from "@/lib/futuresBook";
import { useNow } from "@/lib/useNow";
import type {
  ChainFactsData,
  FuturesDeskRow,
  FuturesRoster,
  FuturesTradeRow,
} from "@/lib/types";

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
  marks,
  source,
}: {
  desks: Record<string, FuturesDeskRow> | undefined;
  trades?: FuturesTradeRow[];
  chain: ChainFactsData | null | undefined;
  live: boolean;
  /** Live oracle marks BY INDEX, used only to price the contract size.
   *
   *  A map, not one number. It was a single `mark` — passed as ACR-INF's —
   *  priced against `rows[0]`, whose order is the crawl's insertion order; and
   *  a throttled first pass back-fills a missed index LATER
   *  (futuresOnchain readDesk retry). So one throttle could put ACR-GPU first
   *  and price its contract at ACR-INF's mark: ~45x wrong, and right the rest
   *  of the time only by accident. A number that is correct because of an
   *  ordering coincidence is the `$1,000 a unit` bug rebuilt from new parts.
   *
   *  Missing entries are fine: the panel states the multiplier and quotes no
   *  dollar figure, which is the honest degradation. */
  marks?: Record<string, number>;
  /** Which tier of the connection ladder served this desk. Every other surface
   *  on the site says where its numbers came from; this one read `source` as a
   *  boolean and told the reader nothing. */
  source?: FuturesRoster["source"];
}) {
  const now = useNow();
  const nowS = now > 0 ? now : Date.now() / 1000;
  const rows = Object.values(desks ?? {});
  const cf = chainFacts(chain);
  const venue = cf.futures;
  const explorer = cf.explorer;
  const primary = rows[0];
  const spark = primary ? inventoryPath(primary.maker_inventory, trades ?? [], primary.series_id) : [];
  // Priced from the row's OWN index, never from whichever row sorted first.
  const notional = primary
    ? contractNotional(marks?.[primary.index_id] ?? 0, primary.multiplier)
    : null;
  const tier = deskTier(source, live);

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">
          <Ed x="The desk — on-chain futures (ACRFutures)" p="The trading desk — real futures on the blockchain" />
        </span>
        {venue ? (
          rows.length ? (
            /* Which tier served these numbers. A direct read of ACRFutures is
               still live — more direct than the press, in fact — so it gets its
               own chip instead of being lumped in with the archive. */
            <span className={`chip ${tier.chip}`}>
              {tier.chip === "chip-sim" ? null : <span className="dot breathe" aria-hidden />}
              <Ed x={tier.x} p={tier.p} />
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
                    <Ed x="Avg price" p="Dealer’s average" />
                  </th>
                  <th>
                    <Ed x="Unrealized" p="Paper P&L" />
                  </th>
                  <th>
                    <Ed x="Realized" p="Banked P&L" />
                  </th>
                  <th>
                    <Ed x="Expiry" p="Settles" />
                  </th>
                  <th>
                    <Ed x="Traders" p="Players" />
                  </th>
                  <th>
                    <Ed x="Series" p="Round" />
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
                      {/* The maker's basis — the average it is carrying the book
                          at. Arrives on every row and was thrown away. */}
                      <td className="mono">
                        {flat ? (
                          <span className="muted">—</span>
                        ) : (
                          <TickerNumber text={r.maker_avg_price.toFixed(5)} />
                        )}
                      </td>
                      <td className="mono">
                        <TickerNumber
                          text={usd(r.maker_unrealized_usdc)}
                          className={r.maker_unrealized_usdc >= 0 ? "green" : "vermilion"}
                        />
                      </td>
                      {/* Realized: money already banked by closed fills. Only
                          the paper figure was ever on screen, so the book looked
                          like it had never actually made anything. */}
                      <td className="mono">
                        <TickerNumber
                          text={usd(r.maker_realized_usdc)}
                          className={r.maker_realized_usdc >= 0 ? "green" : "vermilion"}
                        />
                      </td>
                      {/* Both facts: WHEN it settles, and how long that is. The
                          countdown alone never said which date it lands on —
                          and expiry_ts is real epoch, unlike a print's ts. */}
                      <td className="mono">
                        {r.settled ? (
                          <span className="muted">settled @ {r.settlement_price.toFixed(5)}</span>
                        ) : (
                          <>
                            {expiryLabel(r.expiry_ts)}
                            <br />
                            <span className="muted">{countdown(r.expiry_ts, nowS)}</span>
                          </>
                        )}
                      </td>
                      <td className="mono">
                        <TickerNumber text={String(r.trader_count)} />
                      </td>
                      <td className="mono muted">#{r.series_id}</td>
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

          {/* Per-series constants. A column each would repeat one value down
              every row; a panel states them once. Contract size is DERIVED from
              the series multiplier — the page used to assert the example from
              the contract's own comment and overstate a position 200×. */}
          {primary ? (
            <div className="panel panel-pad" style={{ marginTop: 16 }}>
              <div className="provenance-row">
                <span className="label">
                  <Ed x="Contract size" p="What one contract is worth" />{" "}
                  <span className="muted">{primary.index_id}</span>
                </span>
                <span className="mono">
                  {primary.multiplier}×
                  {notional != null ? (
                    <>
                      {" "}
                      <span className="muted">·</span> {usd(notional)}{" "}
                      <span className="muted">
                        <Ed x="at the current mark" p="at today’s price" />
                      </span>
                    </>
                  ) : null}
                </span>
              </div>
              <div className="provenance-row">
                <span className="label">
                  <Ed x="Maker" p="Who is on the other side" />{" "}
                  <span className="muted">{primary.index_id}</span>
                </span>
                <span className="mono">
                  <AddressChip address={primary.maker} explorer={explorer} copy={false} />{" "}
                  <span className="muted">
                    <Ed
                      x="our Circle developer-controlled wallet — it takes the other side of every fill"
                      p="our own wallet — it takes the other side of every trade"
                    />
                  </span>
                </span>
              </div>
              <div className="provenance-row">
                <span className="label">
                  <Ed x="Settlement" p="How it pays out" />{" "}
                  <span className="muted">{primary.index_id}</span>
                </span>
                <span className="mono">
                  {primary.settled ? (
                    <>
                      {primary.settlement_price.toFixed(5)}{" "}
                      <span className="muted">
                        <Ed x="final" p="final" />
                      </span>
                    </>
                  ) : (
                    <span className="muted">
                      <Ed
                        x="cash, against the oracle print at expiry"
                        p="in cash, against the official rate when it settles"
                      />
                    </span>
                  )}
                </span>
              </div>
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

      <p className="muted" style={{ fontSize: 13, marginTop: 16, maxWidth: 68 * 9 }}>
        <Ed
          x={
            <>
              Every fill is mirrored by the maker; at expiry positions cash-settle against{" "}
              <span className="mono">ACROracle.latestPrint</span> on-chain — no delivery needed.
            </>
          }
          p={
            <>
              Every trade is matched by the dealer; at the deadline each contract{" "}
              <Term k="cash-settled">pays out in cash</Term> against the official on-chain rate.
            </>
          }
        />
        {venue ? (
          <>
            {" "}
            <Ed x="Venue" p="Contract" />{" "}
            <AddressChip address={venue} explorer={explorer} copy={false} />.
          </>
        ) : null}
      </p>
    </section>
  );
}
