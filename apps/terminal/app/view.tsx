"use client";

import { RateBlock } from "@/components/RateBlock";
import { DefensibilityStrip } from "@/components/DefensibilityStrip";
import { PrintsTable } from "@/components/PrintsTable";
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
    return <div className="awaiting">Awaiting print —</div>;
  }

  return (
    <>
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

      <div className="standfirst-block">
        <p className="standfirst" style={{ margin: 0 }}>
          Payment exhaust on Arc is a noisy, adversarial observation of the true price of machine
          services. ACR is the estimator that recovers it — published hourly, with the cost of
          corrupting it.
        </p>
      </div>

      <DefensibilityStrip data={env.data} />

      <section className="section">
        <div className="section-head">
          <span className="label">Today’s prints — settlement grade</span>
        </div>
        <PrintsTable prints={prints} live={env.live} direct={directLive} />
      </section>
    </>
  );
}
