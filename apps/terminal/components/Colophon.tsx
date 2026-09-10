"use client";

import { useConnection } from "@/lib/useConnection";
import { useHumanId } from "@/lib/useLive";
import { deployedContracts } from "@/lib/chain";
import { ArcHorizon } from "./ArcHorizon";
import { ContractRegister } from "./chain/ContractRegister";
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

/* Eleven pills in a flat wrap gave nothing rank: the four deployed addresses,
   the thing anyone actually comes down here for, sat mid-soup between a CAIP-2
   string and a link to the glossary. Three bands now — what the paper is, the
   register (closed), and the press mark — and exactly three affordances at
   rest. Everything the pills carried is still here; only their shape is gone.

   The drawer needs no persistence: this is mounted from app/layout.tsx, so its
   subtree survives every client-side navigation and <details open> holds by
   itself. Only a hard reload closes it, and buying that back would mean a
   second attribute on the edition boot script. Not for a footer. */
export function Colophon({ initial }: { initial: Envelope<TerminalData> }) {
  const conn = useConnection(initial);
  const env = conn.env;
  const rows = deployedContracts(env.data.chain, env.data.oracle);
  /* What "verified" means in THIS deployment, read from the press rather than
     stated from a constant. The gate is an environment variable: a footer that
     named it from a literal would keep claiming one backend after an operator
     switched to another, and the whole point of this line is that a reader does
     not have to take the README's word for what a verified human is here. */
  const info = useHumanId()?.data?.info ?? null;
  // USDC and the Gateway wallet are static constants, so `rows` is never
  // empty. A register worth opening needs at least one ACR contract in it.
  const deployed = rows.filter((r) => r.key !== "usdc" && r.key !== "gateway").length;

  return (
    <footer className="colophon container">
      <div className="colophon-band">
        <Ed
          as="p"
          className="colophon-say"
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

        <div className="colophon-acts">
          <a
            className="chip colophon-act"
            href="/companion"
            title="every term in one line, with an analogy"
          >
            <Ed x="reader’s companion" p="what the words mean" />
          </a>
          {/* The operator's page, linked from the footer rather than the nav.
              A reader who wants to know whether the thing is actually running
              deserves a route to the answer; they do not deserve an eighth
              masthead item to read past on every page. */}
          <a
            className="chip colophon-act"
            href="/ops"
            title="every pillar's standing, as the press reports it"
          >
            <Ed x="systems ledger" p="is it working?" />
          </a>
        </div>
      </div>

      {deployed > 0 && (
        <details className="disclosure colophon-register">
          <summary>
            <Ed x="On-chain register" p="The public record" />
            {/* Outside <Ed>: numbers never dual-render. Inside <summary> and
                unhidden, so the accessible name is "On-chain register 6". */}
            <span className="disclosure-count">{rows.length}</span>
          </summary>
          <div className="disclosure-body">
            <ContractRegister chain={env.data.chain} oracleFallback={env.data.oracle} dense />
          </div>
        </details>
      )}

      <div className="colophon-imprint">
        <p className="mono" style={{ margin: 0 }}>
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

        {/* The identity line. Rendered only when the press answers, because a
            footer that asserted a gate it could not read would be stating the
            one thing this line exists to let a reader check. */}
        {info && (
          <p className="mono muted" style={{ margin: "6px 0 0" }}>
            <Ed x="Identity gate" p="Who counts as a person" /> ·{" "}
            {/* Numbers and the backend name stay outside <Ed>: proper nouns are
                identical in both editions, and a dual-rendered number is a
                number rendered twice. */}
            {info.backend} · {info.rotation_window_days}d{" "}
            <Ed x="rotation" p="before the grouping changes" /> ·{" "}
            {info.sandbox ? (
              <Ed
                x="Sandbox identities, not Orb-verified people"
                p="test accounts, not checked real people"
              />
            ) : (
              <Ed x="Orb-verified" p="checked real people" />
            )}
            {/* A false salt is not a warning, it is a silent zero: every cluster
                id derives to something the tape never wrote, so every human comes
                back with an empty union that reads exactly like "this person has
                never traded". Loud, in the one place an operator will look. */}
            {info.salt_matches_commitment === false && (
              <>
                {" · "}
                <b className="vermilion">
                  <Ed
                    x="SALT MISMATCH: every human resolves to nothing"
                    p="setup error: nobody will be matched to their accounts"
                  />
                </b>
              </>
            )}
          </p>
        )}

        <div className="arc-horizon-mini">
          <ArcHorizon breathe />
        </div>
      </div>
    </footer>
  );
}
