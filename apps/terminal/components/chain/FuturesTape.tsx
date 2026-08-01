"use client";

import { AddressChip } from "./AddressChip";
import { TxLink } from "./TxLink";
import { Ed } from "@/components/Ed";
import { fmt } from "@/lib/format";
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
}: {
  trades: FuturesTradeRow[];
  explorer?: string;
  live: boolean;
}) {
  const nowS = useNow();

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
        {t.side === "buy" ? "BUY" : "SELL"} {Math.abs(t.qty).toFixed(0)}
      </span>
      <span className="amt">@ {fmt(t.mark)}</span>
      <AddressChip address={t.taker} explorer={explorer} copy={false} />
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
