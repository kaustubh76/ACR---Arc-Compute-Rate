"use client";

import { HomeHero } from "@/components/HomeHero";
import { RateBlock } from "@/components/RateBlock";
import { DefensibilityStrip } from "@/components/DefensibilityStrip";
import { FuturesTeaser } from "@/components/FuturesTeaser";
import { TapeTeaser } from "@/components/TapeTeaser";
import { PrintsTable } from "@/components/PrintsTable";
import { PlainPrimer } from "@/components/PlainPrimer";
import { WorkloadRow } from "@/components/WorkloadRow";
import { Ed } from "@/components/Ed";
import { useConnection } from "@/lib/useConnection";
import type { Envelope, TerminalData } from "@/lib/types";

export function FixingView({ initial }: { initial: Envelope<TerminalData> }) {
  const conn = useConnection(initial);
  const env = conn.env;

  // The differentiator tier: when the press is down but ACROracle answers,
  // overlay each row's on-chain block with the FRESH direct read — the hero
  // figures stay settlement-grade truth, not an archived snapshot.
  const direct = !env.live ? conn.onchain?.data?.prints ?? null : null;
  const directLive = conn.state === "onchain-only" && direct != null;
  const prints = Object.values(env.data.prints).map((p) => {
    const d = direct?.[p.index_id];
    return d ? { ...p, onchain: d } : p;
  });

  if (!prints.length) {
    /* "AWAITING THE FIRST PRINT" IS A CLAIM ABOUT THE PRODUCT, and it was being
       made from a payload nobody had read. Off the default chain there is no
       committed bundle to stand in (`bundle: false`), so `emptyTerminal` gives
       `prints: {}` for the whole cold start — measured at 18-19s — and the
       landing page said no rate had ever been published. The index has printed
       hourly since September. `env.live` is what separates "none yet" from
       "not read yet", and only the first is ours to assert. */
    return (
      <div className="awaiting">
        {env.live ? (
          <Ed x="Awaiting the first print" p="Waiting for the first rate" />
        ) : (
          <Ed x="Reading the latest print…" p="Fetching the latest rate…" />
        )}
      </div>
    );
  }

  // Flagship for the hero: ACR-INF if present, else the first print.
  const flagship = prints.find((p) => p.index_id === "ACR-INF") ?? prints[0];

  return (
    <>
      <HomeHero flagship={flagship} data={env.data} live={env.live} direct={directLive} />

      <PlainPrimer />

      {/* `id` + anchor-target: the masthead's workload chip deep-links here
          from every route, and the anchor must clear the sticky masthead. */}
      <section className="section anchor-target" id="fixing">
        <div className="section-head">
          <Ed
            x="Today’s fixing · all three indices"
            p="Today’s official rates · all three services"
            className="label"
          />
          <WorkloadRow />
        </div>
        <div className="hero">
          {prints.map((p) => (
            <RateBlock
              key={p.index_id}
              p={p}
              history={env.data.history?.[p.index_id]}
              live={env.live}
              direct={directLive}
            />
          ))}
        </div>
      </section>

      <DefensibilityStrip data={env.data} />

      <FuturesTeaser data={env.data} />
      <TapeTeaser />

      <section className="section">
        <div className="section-head">
          <span className="label">Today’s prints · settlement grade</span>
        </div>
        <PrintsTable prints={prints} live={env.live} direct={directLive} />
      </section>
    </>
  );
}
