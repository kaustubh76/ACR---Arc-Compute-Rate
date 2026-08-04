"use client";

import Link from "next/link";
import { FuturesTape } from "./chain/FuturesTape";
import { Ed } from "./Ed";
import { Term } from "./Term";
import { chainFacts } from "@/lib/chain";
import { useFutures } from "@/lib/useLive";
import { useDeskAddress } from "@/lib/useDeskAddress";
import { deskIndexPhrase, deskTier, expiryLabel, formatOi } from "@/lib/futuresBook";
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
  const you = useDeskAddress();
  const tier = deskTier(r?.source, live);
  // Every number below is already in the payload the teaser fetches; it showed
  // one of fourteen. Banked PnL is the datum that says "this is really
  // trading" rather than "this exists".
  const traders = desks.reduce((a, d) => a + d.trader_count, 0);
  const pnl = desks.reduce((a, d) => a + d.maker_realized_usdc + d.maker_unrealized_usdc, 0);
  const soonest = desks.length ? Math.min(...desks.map((d) => d.expiry_ts)) : 0;
  // WHICH indices have books is a fact about the venue, read from it. The page
  // used to claim "each index" while one book existed — the same class of
  // mistake as the $1,000 contract size, and disproved by one click.
  const phrase = deskIndexPhrase(desks.map((d) => d.index_id));

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
        <span className={`chip ${tier.chip}`}>
          {tier.chip === "chip-sim" ? null : <span className="dot breathe" aria-hidden />}
          <Ed x={tier.x} p={tier.p} />
        </span>
        <span className="mono">
          {/* formatOi, not toFixed(0): this printed "3" while /curve printed
              "2.8" for the same open interest. */}
          <b style={{ color: "var(--gold)" }}>{formatOi(oi)}</b>{" "}
          <span className="muted">
            <Ed x="contracts open" p="contracts trading" />
          </span>
        </span>
        {traders > 0 ? (
          <span className="mono">
            <b style={{ color: "var(--gold)" }}>{traders}</b>{" "}
            <span className="muted">
              <Ed x="traders" p="people trading" />
            </span>
          </span>
        ) : null}
        {Math.abs(pnl) > 1e-9 ? (
          <span className="mono">
            <b className={pnl >= 0 ? "green" : "vermilion"}>
              {pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)}
            </b>{" "}
            <span className="muted">
              <Ed x="maker P&L" p="the dealer’s profit so far" />
            </span>
          </span>
        ) : null}
        {soonest > 0 ? (
          <span className="mono muted">
            <Ed x="settles " p="pays out " />
            {expiryLabel(soonest)}
          </span>
        ) : null}
      </div>
      <FuturesTape trades={trades} explorer={explorer} live={live} you={you} source={r?.source} />
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 13, marginTop: 12, maxWidth: 68 * 9 }}
        x={`A cash-settled future ${phrase}, settling against the same on-chain oracle as the spot rate — the fills above are real.`}
        p={
          <>
            You can lock in a future price of machine work {phrase} — each contract{" "}
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
