"use client";

import { useEffect, useState } from "react";
import { TxLink } from "./TxLink";

/* Settlement confirmation toast: fired by the console after a paid query.
   Decodes the PAYMENT-RESPONSE envelope into `✓ $x USDC settled → ref`. */
export interface ToastPayload {
  amountUsdc: number;
  txRef: string;
  network?: string;
  key: number; // bump to retrigger
}

export function PaymentToast({ payload, explorer }: { payload: ToastPayload | null; explorer?: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!payload) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 5200);
    return () => clearTimeout(t);
  }, [payload?.key]);

  if (!payload || !visible) return null;
  return (
    <div className="toast" role="status">
      <span className="tick-ok">✓</span>
      <span>
        {payload.amountUsdc.toFixed(6)} USDC settled → <TxLink txRef={payload.txRef} explorer={explorer} />
        {payload.network ? <span className="muted"> · {payload.network}</span> : null}
      </span>
    </div>
  );
}
