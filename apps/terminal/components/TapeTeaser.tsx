"use client";

import Link from "next/link";
import { Ed } from "./Ed";
import { Term } from "./Term";
import { bp, followedReroute, humanCell, type TcaCard } from "@/lib/tape";
import { useTape } from "@/lib/useLive";

/* The tape, on the landing page. Sibling of FuturesTeaser, same shape: a head
   with a link, one row of live figures, one sentence. Until this existed the
   home page had no idea Machine TCA was a thing — the only way to the tape was
   the masthead nav, and the loop this product closes (a purchase is benchmarked,
   the buyer reads its own bill, the next payment moves) was invisible from the
   door. Every figure below is read from /api/tape for the busiest payer, the
   same payload /tape renders; nothing is summarised here that the tape does not
   say itself.

   Returns null when the tape has nothing (no TCA card): the landing page stays
   uncluttered rather than showing an empty frame, the rule FuturesTeaser keeps
   for a missing venue. */

const HEAD = (
  <Ed
    x="Machine TCA · what the buyers actually paid"
    p="The receipts · what the robots really paid"
    className="label"
  />
);

export function TapeTeaser() {
  const { tape } = useTape();
  const data = tape?.data;
  const tca = data?.tca && data.tca.available ? (data.tca as TcaCard) : null;
  if (!tca) return null;

  const live = Boolean(tape?.live);
  const recent = data?.recent ?? [];
  const followed = followedReroute(recent, tca.reroute);
  // People, not wallets: the most any one seller was bought from by distinct
  // verified humans this week. A count the tape measures, or nothing.
  const cells = Object.values(data?.ratings ?? {}).map(humanCell);
  const humans = cells.reduce((m, c) => (c.kind === "count" ? Math.max(m, c.humans) : m), 0);
  const allSandbox = cells.every((c) => c.kind !== "count" || c.allSandbox);

  return (
    <section className="section">
      <div className="section-head">
        {HEAD}
        <span style={{ display: "inline-flex", gap: 14 }}>
          <Link href="/loop" className="section-link">
            <Ed x="Drive the loop →" p="Drive it →" />
          </Link>
          <Link href="/tape" className="section-link">
            <Ed x="Read the tape →" p="See the receipts →" />
          </Link>
        </span>
      </div>
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <span className={`chip ${live ? "chip-teal" : "chip-sim"}`}>
          {live ? <span className="dot breathe" aria-hidden /> : null}
          <Ed x={live ? "indexed by The Graph, live" : "tape unread"} p={live ? "live public record" : "record not read"} />
        </span>
        <span className="mono">
          <b style={{ color: "var(--gold)" }}>{tca.purchases}</b>{" "}
          <span className="muted">
            <Ed x="purchases benchmarked, 7d" p="buys checked against the rate, this week" />
          </span>
        </span>
        {tca.vw_slippage_bp != null ? (
          <span className="mono">
            <b className={tca.vw_slippage_bp > 0 ? "vermilion" : "green"}>{bp(tca.vw_slippage_bp, 0)}</b>{" "}
            <span className="muted">
              <Ed x="over the rate it could see" p="over the going rate" />
            </span>
          </span>
        ) : null}
        {tca.reroute ? (
          <span className="mono">
            <b style={{ color: "var(--finality)" }}>{bp(tca.reroute.saving_bp, 0)}</b>{" "}
            <span className="muted">
              <Ed x="cheaper at the suggested seller" p="cheaper at the better shop" />
            </span>
          </span>
        ) : null}
        {followed === "followed" ? (
          <span className="chip chip-teal">
            <Ed x="the buyer followed it" p="the robot switched" />
          </span>
        ) : null}
        {humans > 0 ? (
          <span className="mono">
            <b style={{ color: "var(--gold)" }}>{humans}</b>{" "}
            <span className="muted">
              <Ed
                x={allSandbox ? "verified people behind one seller · sandbox" : "verified people behind one seller"}
                p={allSandbox ? "real people behind one seller · test accounts" : "real people behind one seller"}
              />
            </span>
          </span>
        ) : null}
      </div>
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 13, marginTop: 4, maxWidth: 68 * 9 }}
        x="Every purchase on the tape is priced against the rate it could have seen at the moment it settled, in the subgraph's own mapping. A buyer that reads its own bill changes shops, and the next payment says so."
        p={
          <>
            Every buy is checked against the <Term k="arrival-price">going rate</Term> the moment it lands. A robot that reads its own bill switches shops, and its next payment shows it.
          </>
        }
      />
    </section>
  );
}
