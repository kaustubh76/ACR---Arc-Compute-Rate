"use client";

import { useEffect, useState } from "react";
import { TxLink } from "./TxLink";
import { Ed } from "@/components/Ed";
import { fmt } from "@/lib/format";
import { formatQty } from "@/lib/futuresBook";

/* The receipt for a trade on the Public Desk.
 *
 * A sibling of PaymentToast rather than an overload of it: same `.toast` shell,
 * different fact. That one confirms money leaving; this one confirms a position
 * opening, and a component straddling both pages would have to know which.
 *
 * It exists because a reader who traded successfully got NOTHING — the flow
 * confirms a fill by watching the position number move, so there was no hash to
 * show and no moment of "that worked". The tx comes from the reader's own
 * indexed `Traded` logs.
 */
export interface FillPayload {
  side: "buy" | "sell";
  qty: number;
  mark: number;
  txRef: string;
  key: number; // bump to retrigger
}

export function FillToast({ payload, explorer }: { payload: FillPayload | null; explorer?: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!payload) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 6500);
    return () => clearTimeout(t);
  }, [payload]);

  if (!payload || !visible) return null;
  return (
    <div className="toast" role="status">
      <span className="tick-ok">✓</span>
      <span>
        <span className={payload.side === "buy" ? "green" : "vermilion"}>
          {payload.side === "buy" ? "BUY" : "SELL"} {formatQty(payload.qty)}
        </span>{" "}
        <Ed x="filled @ " p="traded at " />
        {fmt(payload.mark)} → <TxLink txRef={payload.txRef} explorer={explorer} />
      </span>
    </div>
  );
}
