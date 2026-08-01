"use client";

import { QuoteCorridor } from "@/components/charts/QuoteCorridor";
import { FuturesDesk } from "@/components/chain/FuturesDesk";
import { FuturesTape } from "@/components/chain/FuturesTape";
import { PublicDesk } from "@/components/chain/PublicDesk";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { chainFacts } from "@/lib/chain";
import { useConnection } from "@/lib/useConnection";
import { useEdition } from "@/lib/useEdition";
import { useFutures } from "@/lib/useLive";
import { useNow } from "@/lib/useNow";
import { fmt, serviceName } from "@/lib/format";
import type { Envelope, TerminalData } from "@/lib/types";

/* Curve data is maker quotes the oracle does NOT publish — there is no
   honest direct-read overlay. Off the live tier the page says exactly what
   the corridor is (last-known quotes) instead of pretending. */
function tierBanner(
  state: string,
  ageS: number | null,
  wakeRemainingS: number | null,
  plain: boolean,
) {
  switch (state) {
    case "live":
    case "linking":
      return null;
    case "stale":
      return `last live quotes · ${ageS ?? 0}s ago — retrying`;
    case "waking":
      return plain
        ? `our server is waking · ~${wakeRemainingS ?? 0}s — quotes are last-known until it answers`
        : `press waking · ~${wakeRemainingS ?? 0}s — quotes are last-known until it answers`;
    case "onchain-only":
      return plain
        ? "the live rate reads straight off the blockchain · the quotes below are last-known (the dealer lives on our server)"
        : "spot reads direct from ACROracle · the quotes below are last-known (the maker lives in the press)";
    default:
      return plain
        ? "saved quotes — the corridor re-opens when the live server starts"
        : "archived quotes — the corridor re-opens with the live index API";
  }
}

export function CurveView({ initial }: { initial: Envelope<TerminalData> }) {
  const conn = useConnection(initial);
  const env = conn.env;
  const plain = useEdition() === "plain";
  const prints = Object.values(env.data.prints).filter((p) => p.curve?.length);
  const banner = tierBanner(conn.state, conn.ageS, conn.wakeRemainingS, plain);

  // The futures desk + tape ride a dedicated fast endpoint (real on-chain fills),
  // so they stay lively independent of the heavier /terminal/data feed.
  const fut = useFutures();
  const roster = fut.roster?.data ?? null;
  const futLive = Boolean(fut.roster?.live);
  const explorer = chainFacts(env.data.chain).explorer;
  const nowS = useNow();
  const deskAgeS =
    nowS > 0 && fut.roster ? Math.max(0, nowS - Math.floor(fut.roster.fetchedAt / 1000)) : null;

  return (
    <>
      <div className="standfirst-block" style={{ marginTop: 40 }}>
        <Ed
          as="p"
          className="standfirst"
          style={{ margin: 0 }}
          x="Machine commerce now has a forward curve — weekly tenors, quoted continuously, cash-settled against the oracle print."
          p="You can now lock in next month’s price of machine work — weekly contracts, quoted around the clock, paid out in cash against the official rate."
        />
      </div>

      <section className="section">
        <div className="section-head">
          <Ed
            x="The quote corridor — where the maker trades"
            p="The price corridor — where the dealer buys and sells"
            className="label"
          />
          {banner ? (
            <span
              className="chip chip-gold"
              title={
                plain
                  ? "an honest note about how fresh these quotes are"
                  : "the connection ladder's honest word on these quotes"
              }
            >
              {banner}
            </span>
          ) : null}
        </div>
        <QuoteCorridor prints={env.data.prints} />
      </section>

      <FuturesDesk
        desks={roster?.desks ?? env.data.futures}
        trades={roster?.trades}
        chain={env.data.chain}
        live={futLive}
      />

      <section className="section">
        <div className="section-head">
          <span className="label">
            <Ed x="The tape — live on-chain fills" p="The trade feed — real trades on the blockchain" />
          </span>
          <span className="label">
            {futLive ? (
              <span className="chip chip-teal">
                <span className="dot breathe" aria-hidden />
                {deskAgeS != null ? `updated ${deskAgeS}s ago` : "live"}
              </span>
            ) : (
              <span className="muted">
                <Ed x="archived — awaiting the live venue" p="saved — waiting for the live market" />
              </span>
            )}
          </span>
        </div>
        <FuturesTape trades={roster?.trades ?? []} explorer={explorer} live={futLive} />
      </section>

      <PublicDesk
        desks={roster?.desks ?? env.data.futures}
        live={futLive && roster?.source === "press"}
        explorer={explorer}
      />


      <section className="section">
        <div className="section-head">
          <span className="label">Quotes</span>
        </div>
        <div className="table-scroll">
          <table className="sheet">
            <thead>
              <tr>
                <th>Index</th>
                <th>
                  <Ed x="Tenor" p="Weeks out" />
                </th>
                <th>Bid</th>
                <th>Mid</th>
                <th>Ask</th>
                <th>
                  <Ed x="Spread (bp)" p="Gap (bp)" />
                </th>
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
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: 13, marginTop: 16, maxWidth: 68 * 9 }}
          x={
            <>
              Quotes by an Avellaneda–Stoikov market maker against the latest print — the
              corridor’s width is set by realized vol, its mid pinned to spot at zero inventory.
              The ACR-Weekly future cash-settles against <span className="mono">ACROracle</span> at
              expiry, 1,000 USDC per unit.
            </>
          }
          p={
            <>
              Prices come from an automated <Term k="market-maker">dealer</Term> that always quotes
              a buy and a sell around the latest official rate — the{" "}
              <Term k="vol">jumpier</Term> the market, the wider the gap. At expiry the weekly
              contract is <Term k="cash-settled">paid out in cash</Term> against the rate on the
              public scoreboard, $1,000 per unit.
            </>
          }
        />
      </section>
    </>
  );
}
