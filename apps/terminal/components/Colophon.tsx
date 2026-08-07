"use client";

import { useConnection } from "@/lib/useConnection";
import { addrUrl, chainFacts, tokenUrl } from "@/lib/chain";
import { ArcHorizon } from "./ArcHorizon";
import { AddressChip } from "./chain/AddressChip";
import { Ed } from "./Ed";
import { Term } from "./Term";
import type { Envelope, TerminalData } from "@/lib/types";

/* The edition line follows the connection ladder, not a live/sim binary. */
const EDITION_LINE: Record<string, string> = {
  live: "LIVE EDITION",
  linking: "FIRST EDITION · LINKING",
  stale: "LIVE EDITION · PRESS RETRYING",
  waking: "EDITION IN PRESS · WAKING",
  "onchain-only": "ON-CHAIN EDITION · DIRECT ORACLE READS",
  archived: "ARCHIVED EDITION · START THE INDEX API FOR LIVE DATA",
};

/* The same line, set in plain type. */
const PLAIN_EDITION_LINE: Record<string, string> = {
  live: "LIVE EDITION",
  linking: "FIRST EDITION · CONNECTING",
  stale: "LIVE EDITION · RECONNECTING TO OUR SERVER",
  waking: "EDITION IN PRESS · OUR SERVER IS WAKING UP",
  "onchain-only": "BLOCKCHAIN EDITION · READ STRAIGHT OFF THE PUBLIC RECORD",
  archived: "SAVED COPY · THE LIVE SERVER IS OFF",
};

export function Colophon({ initial }: { initial: Envelope<TerminalData> }) {
  const conn = useConnection(initial);
  const env = conn.env;
  const c = chainFacts(env.data.chain);
  const oracle = c.oracle ?? env.data.oracle ?? null;

  return (
    <footer className="colophon container">
      <Ed
        as="p"
        style={{ margin: 0 }}
        x="Prints are hourly, each with its confidence interval and its attack-cost-per-bp: a bound only Arc’s deterministic USDC fees make a number."
        p={
          <>
            A fresh rate every hour, each with its honest give-or-take and{" "}
            <Term k="attack-cost">the bill for bending it</Term>. Only possible on Arc, where
            fees are fixed dollars.
          </>
        }
      />

      <div className="colophon-facts">
        <span className="chip chip-sky">{c.caip2}</span>
        <a className="chip" href={tokenUrl(c.usdc, c.explorer)} target="_blank" rel="noreferrer">
          <Ed x="USDC · gas token" p="USDC · the dollars that also pay the fees" />
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
        {c.futures && (
          <span className="chip chip-gold" style={{ gap: 8 }}>
            ACRFutures <AddressChip address={c.futures} explorer={c.explorer} copy={false} />
          </span>
        )}
        {/* The fourth contract. It was deployed, exercised and then named
            nowhere — so nothing on the site said that paying for data buys a
            right recorded on chain rather than a row in our own files. */}
        {c.attestor && (
          <span className="chip" style={{ gap: 8 }}>
            FeedAccessAttestor{" "}
            <AddressChip address={c.attestor} explorer={c.explorer} copy={false} />
          </span>
        )}
        {/* All three Circle wallet models are in use here; the colophon named
            only the Gateway one. */}
        {c.futures && (
          <span
            className="chip"
            title="readers trade from Circle user-controlled wallets: the key lives behind their PIN, never with us"
          >
            <Ed x="wallets custody · EOA · user-controlled" p="wallets: ours, yours, and the shop's" />
          </span>
        )}
        <a className="chip" href={c.explorer} target="_blank" rel="noreferrer">
          arcscan ↗
        </a>
        <a className="chip" href="/companion" title="every term in one line, with an analogy">
          <Ed x="reader’s companion" p="what the words mean" />
        </a>
        {/* The operator's page, linked from the footer rather than the nav.
            A reader who wants to know whether the thing is actually running
            deserves a route to the answer; they do not deserve an eighth
            masthead item to read past on every page. */}
        <a className="chip" href="/ops" title="every pillar's standing, as the press reports it">
          <Ed x="systems ledger" p="is it working?" />
        </a>
      </div>

      <p className="mono" style={{ marginBottom: 12 }}>
        <Ed
          x={EDITION_LINE[conn.state] ?? EDITION_LINE.archived}
          p={
            <>
              {PLAIN_EDITION_LINE[conn.state] ?? PLAIN_EDITION_LINE.archived} · SET IN PLAIN TYPE
            </>
          }
        />{" "}
        · AN ARC / CIRCLE BUILD
      </p>

      <div className="arc-horizon-mini">
        <ArcHorizon breathe />
      </div>
    </footer>
  );
}
