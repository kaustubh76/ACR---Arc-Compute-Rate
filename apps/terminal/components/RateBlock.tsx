"use client";

import Link from "next/link";
import { TickerNumber } from "./TickerNumber";
import { Sparkline } from "./charts/Sparkline";
import { FinalityBadge } from "./chain/FinalityBadge";
import { fmt, halfCiBp, heroFigure, money, serviceName } from "@/lib/format";
import type { HistoryPoint, PrintRow } from "@/lib/types";

export function RateBlock({
  p,
  history,
  live = false,
  direct = false,
}: {
  p: PrintRow;
  history?: HistoryPoint[];
  live?: boolean;
  /** the on-chain block is a fresh DIRECT ACROracle read (press down) */
  direct?: boolean;
}) {
  // Lead with the settlement-grade on-chain print; sim estimate is secondary.
  const h = heroFigure(p);
  const spark = (history ?? []).slice(-24).map((h) => h.value);
  return (
    <Link href={`/index/${p.index_id}`} className="rate-block">
      <div className="rb-head">
        <span className="label rb-id">{p.index_id}</span>
        {h.onchain ? (
          <span
            className={`chip ${live || direct ? "chip-teal" : "chip-sim"}`}
            title={
              direct
                ? "read straight from ACROracle by this terminal — the press is down, the print is not"
                : live
                  ? "the print read live from ACROracle — the record contracts settle against"
                  : "last on-chain print (archived snapshot — start the live API for real-time)"
            }
          >
            ⛓ on-chain{direct ? " · direct" : live ? "" : " · archived"}
          </span>
        ) : (
          <span className="chip chip-sim" title="estimator output — no on-chain print yet">
            sim
          </span>
        )}
      </div>
      <div className="rb-service">{serviceName(p.index_id)}</div>
      <div className="rb-value">
        <TickerNumber text={fmt(h.value)} roll />
      </div>
      <div className="rb-unit">{p.unit}</div>
      <div className="rb-ci">
        ±{halfCiBp(h).toFixed(1)} bp <span className="muted">(95%)</span>
      </div>
      {h.onchain && (
        <div className="rb-est muted" title="live estimator reading (sim tape) — the oracle posts this hourly">
          est. {fmt(p.value)}
        </div>
      )}
      <div className="rb-cost">
        Cost to move 1% — <TickerNumber text={money(p.cost_to_move_1pct)} />
      </div>
      <div className="rb-spark">
        <Sparkline values={spark} />
      </div>
      {p.onchain && (
        <div className="rb-meta">
          <FinalityBadge onchain={p.onchain} live={live || direct} micro />
        </div>
      )}
    </Link>
  );
}
