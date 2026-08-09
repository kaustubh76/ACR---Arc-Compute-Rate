"use client";

import Link from "next/link";
import { TickerNumber } from "./TickerNumber";
import { Sparkline } from "./charts/Sparkline";
import { FinalityBadge } from "./chain/FinalityBadge";
import { Ed } from "./Ed";
import { useEdition } from "@/lib/useEdition";
import { fmt, halfCiBp, heroFigure, money, serviceName } from "@/lib/format";
import { useWorkload } from "@/lib/useWorkload";
import { deltaBp, monthlyCost } from "@/lib/workload";
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
  const plain = useEdition() === "plain";
  /* The reader's declared usage, if any. Priced off h.value — the number this
     card is showing — so the personalized line can never disagree with the
     figure above it. Null (no profile / no purchase on this index / no mark)
     renders nothing: the card stays exactly the paper everyone else reads. */
  const w = useWorkload();
  const bill = w ? monthlyCost(w, p.index_id, h.value) : null;
  const bp = deltaBp(history);
  const rawMove = bill !== null && bp !== null ? (bill * bp) / 1e4 : null;
  /* A move that money() would print as $0.00 is dropped, not shown signed.
     The archived bundle's history is exactly 24-periodic, so its delta is a
     true zero: "−$0.00" would be faithful and still read as noise. */
  const move = rawMove !== null && Math.abs(rawMove) >= 0.005 ? rawMove : null;
  const chainTitle = direct
    ? plain
      ? "read straight off the blockchain scoreboard by this page: our server is down, the number is not"
      : "read straight from ACROracle by this terminal: the press is down, the print is not"
    : live
      ? plain
        ? "read live from the public scoreboard: the record real money settles against"
        : "the print read live from ACROracle: the record contracts settle against"
      : plain
        ? "the last recorded rate (saved copy; start the live server for real-time)"
        : "last on-chain print (archived snapshot; start the live API for real-time)";
  return (
    <Link href={`/index/${p.index_id}`} className="rate-block">
      <div className="rb-head">
        <span className="label rb-id">{p.index_id}</span>
        {h.onchain ? (
          <span className={`chip ${live || direct ? "chip-teal" : "chip-sim"}`} title={chainTitle}>
            <Ed
              x={<>⛓ on-chain{direct ? " · direct" : live ? "" : " · archived"}</>}
              p={<>⛓ on the blockchain{direct ? " · read direct" : live ? "" : " · saved copy"}</>}
            />
          </span>
        ) : (
          <span
            className="chip chip-sim"
            title={
              plain
                ? "our estimate: nothing posted to the blockchain yet"
                : "estimator output: no on-chain print yet"
            }
          >
            <Ed x="sim" p="simulation" />
          </span>
        )}
      </div>
      <div className="rb-service">{serviceName(p.index_id)}</div>
      <div className="rb-value">
        <TickerNumber text={fmt(h.value)} roll />
      </div>
      <div className="rb-unit">{p.unit}</div>
      {bill !== null && (
        /* The reader's own line, inside the card rather than beside it. The
           delta applies the history series' 24-fixing move to the bill as a
           RATIO (never a subtraction across the sim/on-chain seam), and a
           short series renders no delta at all: a missing move must never
           read as "unchanged". Cheaper is green: this is a bill. */
        <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
          <Ed x="yours ≈ " p="your bill ≈ " />
          {money(bill)}/mo
          {move !== null && (
            <>
              {" "}
              · <span className={move <= 0 ? "green" : "vermilion"}>
                <Ed x="Δ24 " p="24h " />
                {move <= 0 ? "−" : "+"}
                {money(Math.abs(move))}
              </span>
            </>
          )}
        </div>
      )}
      <div className="rb-ci">
        ±{halfCiBp(h).toFixed(1)}{" "}
        <Ed
          x={
            <>
              bp <span className="muted">(95%)</span>
            </>
          }
          p={
            <>
              bp <span className="muted">(honest wiggle room, 95% sure)</span>
            </>
          }
        />
      </div>
      {h.onchain && (
        <div
          className="rb-est muted"
          title={
            plain
              ? "our freshly computed estimate: it gets posted to the blockchain each hour"
              : "live estimator reading (sim tape): the oracle posts this hourly"
          }
        >
          <Ed x="est. " p="our estimate " />
          {fmt(p.value)}
        </div>
      )}
      <div className="rb-cost">
        <Ed x="Cost to move 1%: " p="To bend this 1%, a cheat must burn " />
        <TickerNumber text={money(p.cost_to_move_1pct)} />
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
