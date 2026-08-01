"use client";

import { HistoryChart } from "@/components/charts/HistoryChart";
import { QuoteCorridor } from "@/components/charts/QuoteCorridor";
import { FuturesDesk } from "@/components/chain/FuturesDesk";
import { OracleProvenance } from "@/components/chain/OracleProvenance";
import { TickerNumber } from "@/components/TickerNumber";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { useFutures, useOnchainHistory } from "@/lib/useLive";
import { useConnection } from "@/lib/useConnection";
import { useEdition } from "@/lib/useEdition";
import { editionLabel, fmt, fmtInt, halfCiBp, heroFigure, money, serviceName } from "@/lib/format";
import type { Envelope, TerminalData } from "@/lib/types";

export function IndexView({ initial, id }: { initial: Envelope<TerminalData>; id: string }) {
  const conn = useConnection(initial);
  const env = conn.env;
  const plain = useEdition() === "plain";
  // The heavier direct read (prints + this index's on-chain history) only
  // spins up while the press is down — null SWR key on the healthy path.
  const direct = useOnchainHistory(id, !env.live && env.fetchedAt !== 0);
  const futures = useFutures();
  const futRow = futures.roster?.data?.desks?.[id] ?? env.data.futures?.[id] ?? null;
  const raw = env.data.prints[id];
  const directPrint = !env.live ? direct?.data?.prints?.[id] ?? conn.onchain?.data?.prints?.[id] : null;

  if (!raw) {
    return (
      <div className="editorial-404">
        <h1>
          <Ed x="No such index is published." p="There is no rate by that name." />
        </h1>
      </div>
    );
  }

  // Overlay the fresh direct ACROracle read over the archived on-chain block —
  // the hero figure stays settlement-grade truth even with the press down.
  const p = directPrint ? { ...raw, onchain: directPrint } : raw;
  const directLive = conn.state === "onchain-only" && directPrint != null;
  const directHistory = !env.live ? direct?.data?.history?.[id] ?? null : null;
  const history = directHistory ?? env.data.history?.[id] ?? [];
  // Lead with the settlement-grade on-chain print; sim estimate shown beside it.
  const h = heroFigure(p);
  const r = p.robustness;

  return (
    <>
      <div style={{ marginTop: 40 }}>
        <div className="rb-head" style={{ maxWidth: 520 }}>
          <span className="label">{p.index_id}</span>
          {h.onchain ? (
            <span
              className={`chip ${env.live || directLive ? "chip-teal" : "chip-sim"}`}
              title={
                directLive
                  ? plain
                    ? "read straight off the blockchain scoreboard by this page — our server is down, the record is not"
                    : "read straight from ACROracle by this terminal — the press is down, the record is not"
                  : env.live
                    ? plain
                      ? "read live from the public scoreboard — the record real money settles against"
                      : "read live from ACROracle — the record contracts settle against"
                    : plain
                      ? "the last recorded rate (saved copy)"
                      : "last on-chain print (archived snapshot)"
              }
            >
              <Ed
                x={<>⛓ on-chain{directLive ? " · direct" : env.live ? "" : " · archived"}</>}
                p={
                  <>
                    ⛓ on the blockchain
                    {directLive ? " · read direct" : env.live ? "" : " · saved copy"}
                  </>
                }
              />
            </span>
          ) : (
            <span className="chip chip-sim">
              <Ed x="sim estimate" p="simulated estimate" />
            </span>
          )}
        </div>
        <div className="rb-service" style={{ fontSize: 22 }}>
          {serviceName(p.index_id)}
        </div>
        <div className="rb-value">
          <TickerNumber text={fmt(h.value)} roll />
        </div>
        <div className="rb-unit">{p.unit}</div>
        <div className="rb-ci">
          ±{halfCiBp(h).toFixed(1)}{" "}
          <Ed
            x={
              <>
                bp <span className="muted">(95%)</span> ·{" "}
                <span className="vermilion">cost to move 1% — {money(p.cost_to_move_1pct)}</span>
              </>
            }
            p={
              <>
                bp <span className="muted">— honest wiggle room, 95% sure</span> ·{" "}
                <span className="vermilion">
                  to bend this 1%, a cheat must burn {money(p.cost_to_move_1pct)}
                </span>
              </>
            }
          />
          {h.onchain && (
            <span className="muted">
              {" "}
              · <Ed x="est. (sim)" p="our estimate" /> {fmt(p.value)}
            </span>
          )}
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <Ed x="The record — recent prints" p="The history — recent official rates" className="label" />
          {directHistory ? (
            <span
              className="chip chip-teal"
              title={
                plain
                  ? "our server is down — these points were read one by one from the blockchain's history"
                  : "the press is down — these points were read row-by-row from ACROracle's on-chain history"
              }
            >
              <Ed
                x={<>last {directHistory.length} prints · read from ACROracle</>}
                p={<>last {directHistory.length} rates · read off the blockchain</>}
              />
            </span>
          ) : null}
        </div>
        <HistoryChart history={history} />
        <div className="lab-counters" style={{ marginTop: 28 }}>
          <div>
            <div className="counter-value" style={{ fontSize: 26 }}>
              {(p.vol * 100).toFixed(1)}%
            </div>
            <div className="counter-label label">
              <Ed x="Annualized vol" p="How jumpy (yearly)" />
            </div>
          </div>
          <div>
            <div className="counter-value" style={{ fontSize: 26 }}>
              {fmtInt(p.n_obs)}
            </div>
            <div className="counter-label label">
              <Ed x="Observations" p="Payments counted" />
            </div>
          </div>
          <div>
            <div className="counter-value" style={{ fontSize: 26 }}>
              {p.cleaned_pct.toFixed(1)}%
            </div>
            <div className="counter-label label">
              <Ed x="Volume cleaned" p="Fake volume removed" />
            </div>
          </div>
          <div>
            <div className="counter-value" style={{ fontSize: 26 }}>
              {editionLabel(p.ts)}
            </div>
            <div className="counter-label label">
              <Ed x="Fixing" p="Edition" />
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <Ed
            x="Provenance — the settlement-grade record"
            p="Proof — the official on-chain copy"
            className="label"
          />
        </div>
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: 13, marginTop: 0, maxWidth: 68 * 9 }}
          x={
            <>
              Contracts settle against the on-chain record, not this page
              {p.onchain
                ? " — the rate above is that record, read from ACROracle; the sim estimator (est.) is what the oracle posts each hour."
                : " — deploy the oracle to publish this fixing on-chain."}
            </>
          }
          p={
            <>
              The number that counts lives on the blockchain, not on this page
              {p.onchain ? (
                <>
                  {" "}
                  — the rate above is that public record, read from an{" "}
                  <Term k="oracle">oracle</Term> contract; “our estimate” is the freshly computed
                  figure that gets posted there each hour.
                </>
              ) : (
                <> — the scoreboard contract is not deployed yet, so this rate is simulation-only.</>
              )}
            </>
          }
        />
        <OracleProvenance
          indexId={id}
          onchain={p.onchain}
          chain={env.data.chain}
          live={env.live}
          direct={directLive}
        />

        <details className="disclosure">
          <summary>
            <Ed
              x="Construction — how this number defends itself"
              p="Under the hood — why this number is hard to fake"
            />
          </summary>
          <div className="disclosure-body">
            <ol className="footnotes">
              <li>
                <Ed
                  className="fn-gloss"
                  x="Share of tape volume removed by funding-graph cleaning and Louvain sybil detection before estimation."
                  p={
                    <>
                      Money flow we threw out as fake before averaging — self-deals and rings of{" "}
                      <Term k="sybil">sock-puppet accounts</Term>, caught by tracing who funds whom.
                    </>
                  }
                />
                <span className="fn-value">{p.cleaned_pct.toFixed(1)}%</span>
              </li>
              {p.trim_alpha != null && (
                <li>
                  <Ed
                    className="fn-gloss"
                    x="Trim level α of the volume-time weighted median — the mass an attacker must outweigh on each side."
                    p={
                      <>
                        How much of the wildest prices we ignore on each side —{" "}
                        <Term k="trimmed-median">Olympic scoring</Term>: the extreme judges don’t
                        count.
                      </>
                    }
                  />
                  <span className="fn-value">α = {p.trim_alpha.toFixed(2)}</span>
                </li>
              )}
              <li>
                <Ed
                  className="fn-gloss"
                  x="Manipulation bound: USDC an attacker must burn to move this print one basis point."
                  p={
                    <>
                      <Term k="attack-cost">The bill for cheating</Term>: dollars an attacker must
                      burn to move this rate one hundredth of a percent.
                    </>
                  }
                />
                <span className="fn-value vermilion">{money(p.attack_cost_per_bp, 4)} / bp</span>
              </li>
              {r && (
                <>
                  <li>
                    <Ed
                      className="fn-gloss"
                      x="Largest single funding cluster’s share of post-cleaning volume — no one identity group dominates the print."
                      p="The biggest single group of connected accounts still only owns this slice of the surviving volume — nobody dominates."
                    />
                    <span className="fn-value">{(100 * r.max_cluster_share).toFixed(1)}%</span>
                  </li>
                  <li>
                    <Ed
                      className="fn-gloss"
                      x="Influence of that cluster on the print if removed entirely."
                      p="How far the rate would move if that whole group were deleted from the data."
                    />
                    <span className="fn-value">{r.max_cluster_influence_bp.toFixed(1)} bp</span>
                  </li>
                  <li>
                    <Ed
                      className="fn-gloss"
                      x="Independent sybil clusters an attacker would need to control to flip the median."
                      p="Separate fake-account rings a cheat would need to run at once to flip the middle value."
                    />
                    <span className="fn-value">{fmtInt(r.sybil_clusters_required)}</span>
                  </li>
                  <li>
                    <Ed
                      className="fn-gloss"
                      x="Minimum distinct identities behind the surviving observations."
                      p="At least this many genuinely different participants stand behind the surviving payments."
                    />
                    <span className="fn-value">{fmtInt(r.min_identities)}</span>
                  </li>
                </>
              )}
            </ol>
          </div>
        </details>
      </section>

      <section className="section">
        <div className="section-head">
          <Ed
            x={<>Quote corridor — {p.index_id}</>}
            p={<>Forward prices — where dealers quote {p.index_id}</>}
            className="label"
          />
        </div>
        <QuoteCorridor prints={{ [p.index_id]: p }} only={p.index_id} />
      </section>

      {futRow ? (
        <FuturesDesk
          desks={{ [p.index_id]: futRow }}
          trades={futures.roster?.data?.trades}
          chain={env.data.chain}
          live={Boolean(futures.roster?.live)}
        />
      ) : null}
    </>
  );
}
