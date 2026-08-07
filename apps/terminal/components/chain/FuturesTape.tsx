"use client";

import { AddressChip } from "./AddressChip";
import { TxLink } from "./TxLink";
import { Ed } from "@/components/Ed";
import { fmt } from "@/lib/format";
import { formatQty, tapeAge } from "@/lib/futuresBook";
import { useNow } from "@/lib/useNow";
import type { FuturesRoster, FuturesTradeRow } from "@/lib/types";

/* The live futures tape: every on-chain fill (an ACRFutures `Traded` event)
   scrolls past — a slow marquee (paused on hover; static under reduced motion).
   BUY green / SELL vermilion, the taker + tx deep-link to Arc, and an honest
   "seen Ns ago" (server-observed, ticking via the shared 1 Hz clock). */
export function FuturesTape({
  trades,
  explorer,
  live,
  you,
  source,
}: {
  trades: FuturesTradeRow[];
  explorer?: string;
  live: boolean;
  /** The reader's own account, so their fills are marked as they scroll past.
   *  Marked, never filtered: watching your own trade go by on the public tape
   *  is the most convincing thing this page does. */
  you?: string;
  /** Which tier served these rows. Archived fills all carry the SAME seen_at
   *  (the snapshot stamp), so ticking it as a live age says one wrong number on
   *  every row and drifts further every hour the bundle sits — "160h ago",
   *  twenty-three times. FinalityBadge already refuses to tick a fake live age
   *  on an archived print; this is the same rule for the tape. */
  source?: FuturesRoster["source"];
}) {
  const nowS = useNow();
  const mine = you?.toLowerCase();

  if (!trades.length) {
    return (
      <div className="tape">
        <div className="tape-static">
          <span className="tape-item muted">
            <Ed
              x="awaiting fills: the desk is quiet, and fills print here the moment they land on-chain"
              p="waiting for trades: the desk is quiet, and trades appear the moment they happen"
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
      {(() => {
        const age = tapeAge(t.seen_at, nowS, source);
        return age.text ? <span className="muted">{age.text}</span> : null;
      })()}
    </span>
  ));

  return (
    <div className="tape" title={live ? "live futures fills on Arc" : "recent fills · archived"}>
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
