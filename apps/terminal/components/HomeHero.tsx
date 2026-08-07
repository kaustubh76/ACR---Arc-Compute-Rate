"use client";

import Link from "next/link";
import { TickerNumber } from "@/components/TickerNumber";
import { Ed } from "@/components/Ed";
import { fmt, fmtInt, heroFigure, serviceName } from "@/lib/format";
import type { PrintRow, TerminalData } from "@/lib/types";

/* The landing moment: Arc's dawn as a full-viewport hero. A giant live-ticking
   flagship rate over the signature rising-sun/arc field, the thesis line, and
   the manipulation-resistance stat. The flagship number is badged with the SAME
   honesty tier the cards use (live / on-chain direct / archived / sim) — it
   never fakes freshness. Motion is CSS and fully disabled under
   prefers-reduced-motion (globals.css blanket reset). */

/** Resistance ratio — mirrors DefensibilityStrip so the hero + strip agree. */
function resistanceRatio(data: TerminalData): number | null {
  const atk = data.attack;
  if (!atk?.series?.length && !atk?.per_index?.length) return null;
  const worst = atk.per_index?.length
    ? atk.per_index.reduce((a, b) =>
        Math.abs(b.vwap_swing_pct) > Math.abs(a.vwap_swing_pct) ? b : a,
      )
    : null;
  const r = worst
    ? Math.abs(worst.vwap_swing_pct) / Math.max(0.01, Math.abs(worst.acr_swing_pct))
    : Math.max(...atk.series.map((s) => s.vwap_err_bp)) /
      Math.max(0.01, Math.max(...atk.series.map((s) => s.acr_err_bp)));
  /* Below 1× the sentence stops being true — "0× more manipulation-resistant
     than naive VWAP" is the headline claim inverted, and `fmtInt` rounds
     anything under 0.5 to exactly that. A run where the naive statistic
     happened not to move is not evidence against the index; it is a run with
     nothing to say. Say nothing: the caller hides the stat when this is null. */
  return finite(r) && r >= 1 ? r : null;
}

function finite(n: number): boolean {
  return Number.isFinite(n);
}

function HeroBadge({
  onchain,
  live,
  direct,
}: {
  onchain: boolean;
  live: boolean;
  direct: boolean;
}) {
  if (!onchain) {
    return (
      <span className="chip chip-sim">
        <Ed x="sim estimate" p="simulated estimate" />
      </span>
    );
  }
  if (live) {
    return (
      <span className="chip chip-teal">
        <i className="dot breathe" /> <Ed x="⛓ on-chain · live" p="⛓ on the blockchain · live" />
      </span>
    );
  }
  if (direct) {
    return (
      <span className="chip chip-teal">
        <i className="dot breathe" />{" "}
        <Ed x="⛓ on-chain · direct read" p="⛓ on the blockchain · read direct" />
      </span>
    );
  }
  return (
    <span className="chip chip-sim">
      <Ed x="⛓ on-chain · archived" p="⛓ on the blockchain · saved copy" />
    </span>
  );
}

export function HomeHero({
  flagship,
  data,
  live,
  direct,
}: {
  flagship: PrintRow;
  data: TerminalData;
  live: boolean;
  direct: boolean;
}) {
  const h = heroFigure(flagship);
  const resist = resistanceRatio(data);

  return (
    <section className="home-hero" aria-label="Arc Compute Rate · live fixing">
      {/* the dawn field: rising sun + concentric arcs of light over the horizon */}
      <div className="home-hero-sky" aria-hidden>
        <svg viewBox="0 0 1200 620" preserveAspectRatio="xMidYMid slice">
          <defs>
            <radialGradient id="hh-sun" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#f5ecda" stopOpacity="0.85" />
              <stop offset="30%" stopColor="#e9a13f" stopOpacity="0.42" />
              <stop offset="100%" stopColor="#e9a13f" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="hh-arc" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#acc6e9" stopOpacity="0" />
              <stop offset="50%" stopColor="#acc6e9" stopOpacity="0.4" />
              <stop offset="82%" stopColor="#e9a13f" stopOpacity="0.42" />
              <stop offset="100%" stopColor="#e9a13f" stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* horizon at ~78% down; the sun rides it */}
          <circle className="hh-sun" cx="600" cy="486" r="180" fill="url(#hh-sun)" />
          {[150, 250, 360, 480].map((r) => (
            <path
              key={r}
              className="hh-arc"
              d={`M ${600 - r} 486 A ${r} ${r} 0 0 1 ${600 + r} 486`}
              fill="none"
              stroke="url(#hh-arc)"
              strokeWidth={1.25}
            />
          ))}
          <line x1="0" y1="486" x2="1200" y2="486" stroke="#e9a13f" strokeOpacity="0.34" strokeWidth="1" />
        </svg>
      </div>

      <div className="home-hero-inner">
        <Ed
          as="p"
          className="eyebrow home-hero-eyebrow"
          x="Arc Compute Rate · the reference rate for machine commerce"
          p="Arc Compute Rate · what machines pay other machines for work"
        />

        <div className="home-hero-flagship">
          <div className="home-hero-idline">
            <span className="label">{flagship.index_id}</span>
            <span className="muted">{serviceName(flagship.index_id)}</span>
            <HeroBadge onchain={h.onchain} live={live} direct={direct} />
          </div>
          <div className="home-hero-rate">
            <TickerNumber text={fmt(h.value)} roll />
          </div>
          <div className="home-hero-unit">
            {flagship.unit}
            {h.onchain ? <span className="muted"> · est. (sim) {fmt(flagship.value)}</span> : null}
          </div>
        </div>

        <h1 className="home-hero-thesis">
          <Ed
            x={
              <>
                Machine commerce just got its SOFR:{" "}
                <span className="gold">it prints its own attack cost.</span>
              </>
            }
            p={
              <>
                Machines buying from machines finally have an official price:{" "}
                <span className="gold">it publishes the cost of faking it.</span>
              </>
            }
          />
        </h1>

        <div className="home-hero-foot">
          {resist != null ? (
            <div className="home-hero-stat">
              <span className="home-hero-stat-num gold">{fmtInt(resist)}×</span>
              <Ed
                x="more manipulation-resistant than naive VWAP"
                p="harder to fake than a plain average"
                className="home-hero-stat-cap"
              />
            </div>
          ) : null}
          {/* Two doors, not one. The attack lab is a thing to watch; the desk
              is the thing a reader can DO, and until now the only route to it
              was a teaser link that disappeared whenever the press was cold. */}
          <div className="home-hero-cta">
            <Link href="/attack" className="btn">
              <Ed x="Watch the attack →" p="Watch someone try to cheat it →" />
            </Link>
            <Link href="/curve#desk" className="btn">
              <Ed x="Open the desk →" p="Place a real trade →" />
            </Link>
            <span className="home-hero-scroll" aria-hidden>
              <Ed x="today’s fixing ↓" p="today’s rates ↓" />
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
