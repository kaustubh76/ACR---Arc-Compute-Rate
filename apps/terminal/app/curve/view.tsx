"use client";

import { QuoteCorridor } from "@/components/charts/QuoteCorridor";
import { FuturesDesk } from "@/components/chain/FuturesDesk";
import { FuturesMarkChart } from "@/components/charts/FuturesMarkChart";
import { FuturesTape } from "@/components/chain/FuturesTape";
import { HedgerPanel } from "@/components/chain/HedgerPanel";
import { PublicDesk } from "@/components/chain/PublicDesk";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { chainFacts } from "@/lib/chain";
import { useConnection } from "@/lib/useConnection";
import { useEdition } from "@/lib/useEdition";
import { useFutures, useHedger } from "@/lib/useLive";
import { useNow } from "@/lib/useNow";
import { useDeskAddress } from "@/lib/useDeskAddress";
import { contractNotional } from "@/lib/futuresBook";
import { fmt, heroFigure, money, serviceName } from "@/lib/format";
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
        ? "the rate reads off the blockchain — these quotes are last-known (the dealer lives on our server)"
        : "spot reads direct from ACROracle — these quotes are last-known (the maker lives in the press)";
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
  const hedge = useHedger();
  const roster = fut.roster?.data ?? null;
  const futLive = Boolean(fut.roster?.live);
  const explorer = chainFacts(env.data.chain).explorer;
  const nowS = useNow();
  const you = useDeskAddress();
  const deskAgeS =
    nowS > 0 && fut.roster ? Math.max(0, nowS - Math.floor(fut.roster.fetchedAt / 1000)) : null;

  // What one contract is actually worth, read off the live series instead of
  // written down. Leads with the on-chain print (heroFigure) because that is
  // the number the contract settles against.
  const primaryDesk = (() => {
    const desks = roster?.desks ?? env.data.futures;
    return desks?.["ACR-INF"] ?? Object.values(desks ?? {})[0];
  })();
  const contractSize = (() => {
    const row = primaryDesk;
    const print = row ? env.data.prints[row.index_id] : undefined;
    if (!row || !print) return null;
    const mark = heroFigure(print).value;
    const notional = contractNotional(mark, row.multiplier);
    return notional == null ? null : { multiplier: row.multiplier, notional, mark };
  })();

  return (
    <>
      <div className="standfirst-block" style={{ marginTop: 40 }}>
        <Ed
          as="p"
          className="standfirst"
          style={{ margin: 0 }}
          x="Machine commerce has a forward curve — weekly tenors, quoted continuously, cash-settled against the oracle print."
          p="You can lock in next month’s price of machine work — weekly contracts, paid out in cash against the official rate."
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
        mark={contractSize?.mark}
        source={roster?.source}
      />

      {/* What the futures actually traded at, against the rate they settle on.
          Reads book → mark → tape: the desk states the position, the chart
          shows how it got there, the tape scrolls the fills one by one. */}
      {primaryDesk ? (
        <section className="section">
          <div className="section-head">
            <span className="label">
              <Ed
                x="Fills against the oracle — what the future traded at"
                p="Trades against the official rate — what people paid"
              />
            </span>
            <span className="label muted">
              <Ed x="every dot is one on-chain fill" p="every dot is one real trade" />
            </span>
          </div>
          <FuturesMarkChart
            trades={roster?.trades ?? []}
            seriesId={primaryDesk.series_id}
            oracle={contractSize?.mark ?? null}
            you={you}
          />
          <Ed
            as="p"
            className="muted"
            style={{ fontSize: 13, marginTop: 12, maxWidth: 68 * 9 }}
            x="The dashed line is the on-chain print these contracts cash-settle against; the gap is the basis, in basis points."
            p={
              <>
                The dashed line is the official rate these contracts{" "}
                <Term k="cash-settled">pay out</Term> against — the space between is{" "}
                <Term k="basis">the gap</Term>.
              </>
            }
          />
        </section>
      ) : null}

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
        <FuturesTape trades={roster?.trades ?? []} explorer={explorer} live={futLive} you={you} />
      </section>

      {/* Trading needs chain-backed series data, which the press and the direct
          viem tier both provide — only the archived bundle can't. Requiring the
          PRESS specifically used to hide the desk whenever Arc's RPC was slow
          enough for the roster to fall through to the chain tier, which is
          often. If the press really is unreachable, the desk's own calls say so. */}
      <PublicDesk
        desks={roster?.desks ?? env.data.futures}
        live={futLive && roster?.source !== "bundle"}
        explorer={explorer}
      />

      {/* The reader trades from their own wallet above; this is the machine
          doing the same thing unattended, one section down, so the comparison
          is the page rather than a paragraph about it. */}
      <HedgerPanel
        state={hedge.hedger?.data ?? null}
        live={Boolean(hedge.hedger?.live)}
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
        {/* The contract size is DERIVED, never authored. This sentence used to
            state 1,000 USDC a contract — the example from ACRFutures.sol's own
            comment — while the live series runs a multiplier of 10, so it
            overstated a position 200×. `contractNotional` returns null rather
            than a confident zero, and the null branch quotes no figure at all. */}
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: 13, marginTop: 16, maxWidth: 68 * 9 }}
          x={
            <>
              An Avellaneda–Stoikov maker quotes both sides of the latest print; the weekly future
              settles in cash on <span className="mono">ACROracle</span>
              {contractSize
                ? ` at ${contractSize.multiplier}× the index — ${money(contractSize.notional)} a contract at today's mark.`
                : "."}
            </>
          }
          p={
            <>
              An automated <Term k="market-maker">dealer</Term> quotes both sides of the official
              rate; weekly contracts <Term k="cash-settled">pay out in cash</Term> against it
              {contractSize
                ? `, and one contract is worth about ${money(contractSize.notional)} at today's price.`
                : "."}
            </>
          }
        />
      </section>
    </>
  );
}
