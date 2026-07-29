"use client";

import { HistoryChart } from "@/components/charts/HistoryChart";
import { QuoteCorridor } from "@/components/charts/QuoteCorridor";
import { OracleProvenance } from "@/components/chain/OracleProvenance";
import { TickerNumber } from "@/components/TickerNumber";
import { useOnchainHistory } from "@/lib/useLive";
import { useConnection } from "@/lib/useConnection";
import { editionLabel, fmt, fmtInt, halfCiBp, heroFigure, money, serviceName } from "@/lib/format";
import type { Envelope, TerminalData } from "@/lib/types";

export function IndexView({ initial, id }: { initial: Envelope<TerminalData>; id: string }) {
  const conn = useConnection(initial);
  const env = conn.env;
  // The heavier direct read (prints + this index's on-chain history) only
  // spins up while the press is down — null SWR key on the healthy path.
  const direct = useOnchainHistory(id, !env.live && env.fetchedAt !== 0);
  const raw = env.data.prints[id];
  const directPrint = !env.live ? direct?.data?.prints?.[id] ?? conn.onchain?.data?.prints?.[id] : null;

  if (!raw) {
    return (
      <div className="editorial-404">
        <h1>No such index is published.</h1>
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
                  ? "read straight from ACROracle by this terminal — the press is down, the record is not"
                  : env.live
                    ? "read live from ACROracle — the record contracts settle against"
                    : "last on-chain print (archived snapshot)"
              }
            >
              ⛓ on-chain{directLive ? " · direct" : env.live ? "" : " · archived"}
            </span>
          ) : (
            <span className="chip chip-sim">sim estimate</span>
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
          ±{halfCiBp(h).toFixed(1)} bp <span className="muted">(95%)</span> ·{" "}
          <span className="vermilion">cost to move 1% — {money(p.cost_to_move_1pct)}</span>
          {h.onchain && <span className="muted"> · est. (sim) {fmt(p.value)}</span>}
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <span className="label">The record — recent prints</span>
          {directHistory ? (
            <span
              className="chip chip-teal"
              title="the press is down — these points were read row-by-row from ACROracle's on-chain history"
            >
              last {directHistory.length} prints · read from ACROracle
            </span>
          ) : null}
        </div>
        <HistoryChart history={history} />
        <div className="lab-counters" style={{ marginTop: 28 }}>
          <div>
            <div className="counter-value" style={{ fontSize: 26 }}>
              {(p.vol * 100).toFixed(1)}%
            </div>
            <div className="counter-label label">Annualized vol</div>
          </div>
          <div>
            <div className="counter-value" style={{ fontSize: 26 }}>
              {fmtInt(p.n_obs)}
            </div>
            <div className="counter-label label">Observations</div>
          </div>
          <div>
            <div className="counter-value" style={{ fontSize: 26 }}>
              {p.cleaned_pct.toFixed(1)}%
            </div>
            <div className="counter-label label">Volume cleaned</div>
          </div>
          <div>
            <div className="counter-value" style={{ fontSize: 26 }}>
              {editionLabel(p.ts)}
            </div>
            <div className="counter-label label">Fixing</div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <span className="label">Provenance — the settlement-grade record</span>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0, maxWidth: 68 * 9 }}>
          Contracts settle against the on-chain record, not this page
          {p.onchain
            ? " — the rate above is that record, read from ACROracle; the sim estimator (est.) is what the oracle posts each hour."
            : " — deploy the oracle to publish this fixing on-chain."}
        </p>
        <OracleProvenance
          indexId={id}
          onchain={p.onchain}
          chain={env.data.chain}
          live={env.live}
          direct={directLive}
        />

        <details className="disclosure">
          <summary>Construction — how this number defends itself</summary>
          <div className="disclosure-body">
            <ol className="footnotes">
              <li>
                <span className="fn-gloss">
                  Share of tape volume removed by funding-graph cleaning and Louvain sybil
                  detection before estimation.
                </span>
                <span className="fn-value">{p.cleaned_pct.toFixed(1)}%</span>
              </li>
              {p.trim_alpha != null && (
                <li>
                  <span className="fn-gloss">
                    Trim level α of the volume-time weighted median — the mass an attacker must
                    outweigh on each side.
                  </span>
                  <span className="fn-value">α = {p.trim_alpha.toFixed(2)}</span>
                </li>
              )}
              <li>
                <span className="fn-gloss">
                  Manipulation bound: USDC an attacker must burn to move this print one basis
                  point.
                </span>
                <span className="fn-value vermilion">{money(p.attack_cost_per_bp, 4)} / bp</span>
              </li>
              {r && (
                <>
                  <li>
                    <span className="fn-gloss">
                      Largest single funding cluster’s share of post-cleaning volume — no one
                      identity group dominates the print.
                    </span>
                    <span className="fn-value">{(100 * r.max_cluster_share).toFixed(1)}%</span>
                  </li>
                  <li>
                    <span className="fn-gloss">
                      Influence of that cluster on the print if removed entirely.
                    </span>
                    <span className="fn-value">{r.max_cluster_influence_bp.toFixed(1)} bp</span>
                  </li>
                  <li>
                    <span className="fn-gloss">
                      Independent sybil clusters an attacker would need to control to flip the
                      median.
                    </span>
                    <span className="fn-value">{fmtInt(r.sybil_clusters_required)}</span>
                  </li>
                  <li>
                    <span className="fn-gloss">
                      Minimum distinct identities behind the surviving observations.
                    </span>
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
          <span className="label">Quote corridor — {p.index_id}</span>
        </div>
        <QuoteCorridor prints={{ [p.index_id]: p }} only={p.index_id} />
      </section>
    </>
  );
}
