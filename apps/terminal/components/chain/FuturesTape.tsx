"use client";

import { AddressChip } from "./AddressChip";
import { TxLink } from "./TxLink";
import { Ed } from "@/components/Ed";
import { fmt } from "@/lib/format";
import { formatQty } from "@/lib/futuresBook";
import { useNow } from "@/lib/useNow";
import type { FuturesTradeRow } from "@/lib/types";

/* The live futures tape: every on-chain fill (an ACRFutures `Traded` event)
   scrolls past — a slow marquee (paused on hover; static under reduced motion).
   BUY green / SELL vermilion, the taker + tx deep-link to Arc, and an honest
   "seen Ns ago" (server-observed, ticking via the shared 1 Hz clock). */
function ago(nowS: number, s: number): string {
  const d = Math.max(0, nowS - Math.floor(s));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  return `${Math.floor(d / 3600)}h`;
}

export function FuturesTape({
  trades,
  explorer,
  live,
  you,
}: {
  trades: FuturesTradeRow[];
  explorer?: string;
  live: boolean;
  /** The reader's own account, so their fills are marked as they scroll past.
   *  Marked, never filtered: watching your own trade go by on the public tape
   *  is the most convincing thing this page does. */
  you?: string;
}) {
  const nowS = useNow();
  const mine = you?.toLowerCase();

  if (!trades.length) {
    return (
      <div className="tape">
        <div className="tape-static">
          <span className="tape-item muted">
            <Ed
              x="awaiting fills — the desk is quiet (fills print here the moment they land on-chain)"
              p="waiting for trades — the desk is quiet (trades appear here the moment they happen)"
            />
          </span>
        </div>
      </div>
    );
  }

  const items = trades.slice(0, 24).map((t) => (
    <span className="tape-item" key={t.tx}>
      <span className={t.side === "buy" ? "green" : "vermilion"}>
        {/* formatQty, not toFixed(0): the venue's real 0.25 and 0.81 contract
            fills used to print as "BUY 0" and "BUY 1" on the public tape. */}
        {t.side === "buy" ? "BUY" : "SELL"} {formatQty(t.qty)}
      </span>
      <span className="amt">@ {fmt(t.mark)}</span>
      <AddressChip address={t.taker} explorer={explorer} copy={false} />
      {mine && t.taker.toLowerCase() === mine ? (
        <span className="chip chip-teal">
          <Ed x="you" p="you" />
        </span>
      ) : null}
      <TxLink txRef={t.tx} explorer={explorer} />
      {nowS > 0 ? <span className="muted">{ago(nowS, t.seen_at)} ago</span> : null}
    </span>
  ));

  return (
    <div className="tape" title={live ? "live futures fills on Arc" : "recent fills — archived"}>
      <div className="tape-track">
        {items}
        <span aria-hidden className="tape-item muted">
          <Ed x="· cash-settled vs the oracle ·" p="· paid out against the official rate ·" />
        </span>
        {items.map((el, i) => (
          <span aria-hidden key={`dup-${i}`}>
            {el}
          </span>
        ))}
      </div>
    </div>
  );
}
