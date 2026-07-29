"use client";

import Link from "next/link";
import { fmtInt, money } from "@/lib/format";
import type { TerminalData } from "@/lib/types";

/* One row on the home page: peak estimator error under an identical attack,
   VWAP vs ACR, and the resistance ratio. The full exercise lives in the Lab. */
export function DefensibilityStrip({ data }: { data: TerminalData }) {
  const atk = data.attack;
  if (!atk?.series?.length) {
    // Reserve the section instead of vanishing — no layout shift when the
    // attack summary streams in a poll later.
    return (
      <section className="section" aria-busy="true">
        <div className="section-head">
          <span className="label">Defensibility — peak error under an identical attack</span>
        </div>
        <div className="skel" style={{ height: 96 }} />
      </section>
    );
  }

  const peakVwap = Math.max(...atk.series.map((s) => s.vwap_err_bp));
  const peakAcr = Math.max(...atk.series.map((s) => s.acr_err_bp));
  const worst = atk.per_index.length
    ? atk.per_index.reduce((a, b) =>
        Math.abs(b.vwap_swing_pct) > Math.abs(a.vwap_swing_pct) ? b : a,
      )
    : null;
  const resist = worst
    ? Math.abs(worst.vwap_swing_pct) / Math.max(0.01, Math.abs(worst.acr_swing_pct))
    : peakVwap / Math.max(0.01, peakAcr);
  const scale = Math.max(peakVwap, 1);

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">Defensibility — peak error under an identical attack</span>
        <Link href="/attack" className="section-link">
          Attack the index →
        </Link>
      </div>
      <div className="defense">
        <div className="defense-bars">
          <div className="defense-bar-row">
            <span className="label vermilion">Naive VWAP</span>
            <span className="defense-bar">
              <i className="fill-vwap" style={{ width: `${(100 * peakVwap) / scale}%` }} />
            </span>
            <span className="num">{fmtInt(peakVwap)} bp</span>
          </div>
          <div className="defense-bar-row">
            <span className="label gold">ACR</span>
            <span className="defense-bar">
              <i
                className="fill-acr"
                style={{ width: `${Math.max(0.75, (100 * peakAcr) / scale)}%` }}
              />
            </span>
            <span className="num">{fmtInt(peakAcr)} bp</span>
          </div>
        </div>
        <div className="defense-verdict">
          <div className="defense-ratio">{fmtInt(resist)}×</div>
          <div className="defense-caption">
            more resistant than naive VWAP — the attacker burned {money(atk.usdc_burned, 0)} across{" "}
            {fmtInt(atk.n_adversarial)} wash prints trying.
          </div>
        </div>
      </div>
    </section>
  );
}
