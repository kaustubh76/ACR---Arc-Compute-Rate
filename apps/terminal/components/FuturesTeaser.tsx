"use client";

import Link from "next/link";
import { FuturesTape } from "./chain/FuturesTape";
import { Ed } from "./Ed";
import { Term } from "./Term";
import { chainFacts } from "@/lib/chain";
import { useFutures } from "@/lib/useLive";
import type { TerminalData } from "@/lib/types";

/* The home page's window into pillar 4: the machine-commerce futures desk is
   trading right now, so the landing page shows it — a live open-interest datum
   and the real on-chain fills scrolling past, one click from the full desk.
   Renders only when a venue is deployed (else the home page stays clean). */
const HEAD = (
  <Ed
    x="The desk — machine commerce, trading forward"
    p="The trading desk — buying and selling future prices"
    className="label"
  />
);

export function FuturesTeaser({ data }: { data: TerminalData }) {
  const { roster } = useFutures();
  const r = roster?.data ?? null;
  const live = Boolean(roster?.live);
  const trades = r?.trades ?? [];
  const explorer = chainFacts(data.chain).explorer;
  const desks = r?.desks ? Object.values(r.desks) : [];
  const oi = desks.reduce((a, d) => a + d.open_interest, 0);
  const venue = r?.venue ?? data.chain?.futures_address ?? null;

  if (!venue) return null; // no venue deployed → keep the landing page uncluttered

  return (
    <section className="section">
      <div className="section-head">
        {HEAD}
        <Link href="/curve" className="section-link">
          <Ed x="Trade the curve →" p="See the trading desk →" />
        </Link>
      </div>
      <div
        style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}
      >
        {live ? (
          <span className="chip chip-teal">
            <span className="dot breathe" aria-hidden />
            live
          </span>
        ) : (
          <span className="chip chip-sim">archived</span>
        )}
        <span className="mono">
          <b style={{ color: "var(--gold)" }}>{oi.toFixed(0)}</b>{" "}
          <span className="muted">
            <Ed x="contracts open" p="contracts trading" />
          </span>
        </span>
      </div>
      <FuturesTape trades={trades} explorer={explorer} live={live} />
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 13, marginTop: 12, maxWidth: 68 * 9 }}
        x="A cash-settled weekly future on each index, settling against the same on-chain oracle as the spot rate — the fills above are real."
        p={
          <>
            You can lock in a future price of machine work — each contract{" "}
            <Term k="cash-settled">pays out</Term> against the official on-chain rate, and the
            trades above are real.
          </>
        }
      />
      {/* The teaser used to describe the desk as something to look at. A reader
          can actually trade on it, and nothing on the home page said so. */}
      {live && (
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: 13, marginTop: 6, maxWidth: 68 * 9 }}
          x={
            <>
              Take a side yourself — a Circle wallet behind your PIN, a $0.50 testnet stake, and
              your fill lands on-chain. <Link href="/curve">Trade it →</Link>
            </>
          }
          p={
            <>
              You can try it yourself — make a wallet with a PIN, get 50 cents of test money,
              and place a real trade. <Link href="/curve">Try it →</Link>
            </>
          }
        />
      )}
    </section>
  );
}
