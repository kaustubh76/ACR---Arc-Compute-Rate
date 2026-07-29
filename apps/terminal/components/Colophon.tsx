"use client";

import { useConnection } from "@/lib/useConnection";
import { addrUrl, chainFacts, tokenUrl } from "@/lib/chain";
import { ArcHorizon } from "./ArcHorizon";
import { AddressChip } from "./chain/AddressChip";
import type { Envelope, TerminalData } from "@/lib/types";

/* The edition line follows the connection ladder, not a live/sim binary. */
const EDITION_LINE: Record<string, string> = {
  live: "LIVE EDITION",
  linking: "FIRST EDITION — LINKING",
  stale: "LIVE EDITION — PRESS RETRYING",
  waking: "EDITION IN PRESS — WAKING",
  "onchain-only": "ON-CHAIN EDITION — DIRECT ORACLE READS",
  archived: "ARCHIVED EDITION — START THE INDEX API FOR LIVE DATA",
};

export function Colophon({ initial }: { initial: Envelope<TerminalData> }) {
  const conn = useConnection(initial);
  const env = conn.env;
  const c = chainFacts(env.data.chain);
  const oracle = c.oracle ?? env.data.oracle ?? null;

  return (
    <footer className="colophon container">
      <p style={{ margin: 0 }}>
        Prints are hourly; each ships with its confidence interval and its attack-cost-per-bp.
        Estimator: state-space deconvolution of the Gateway batching operator · funding-graph
        cleaning with Louvain sybil detection · volume-time α-trimmed weighted median · hedonic
        constant-quality adjustment · manipulation cost bound. Only computable on Arc —
        deterministic, dollar-denominated USDC fees make the bound a number, not a distribution.
      </p>

      <div className="colophon-facts">
        <span className="chip chip-sky">{c.caip2}</span>
        <a className="chip" href={tokenUrl(c.usdc, c.explorer)} target="_blank" rel="noreferrer">
          USDC · gas token
        </a>
        <a
          className="chip"
          href={addrUrl(c.gatewayWallet, c.explorer)}
          target="_blank"
          rel="noreferrer"
        >
          GatewayWallet {c.gatewayWallet.slice(0, 6)}…{c.gatewayWallet.slice(-4)}
        </a>
        {oracle && (
          <span className="chip chip-gold" style={{ gap: 8 }}>
            ACROracle <AddressChip address={oracle} explorer={c.explorer} copy={false} />
          </span>
        )}
        {c.registry && (
          <span className="chip" style={{ gap: 8 }}>
            AttestationRegistry <AddressChip address={c.registry} explorer={c.explorer} copy={false} />
          </span>
        )}
        <a className="chip" href={c.explorer} target="_blank" rel="noreferrer">
          arcscan ↗
        </a>
      </div>

      <p className="mono" style={{ marginBottom: 12 }}>
        {EDITION_LINE[conn.state] ?? EDITION_LINE.archived} · AN ARC / CIRCLE BUILD
      </p>

      <div className="arc-horizon-mini">
        <ArcHorizon breathe />
      </div>
    </footer>
  );
}
