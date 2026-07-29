"use client";

import { useMarketReceipts } from "@/lib/useLive";
import { AddressChip } from "./AddressChip";
import { TxLink } from "./TxLink";
import type { MarketReceiptsData } from "@/lib/types";

/* The settlement tape: every paid x402 query prints here. A slow marquee
   (paused on hover; static scroll under reduced motion). Live receipts when
   the gate is up; the bundled sim tape otherwise — always moving, never
   blank. */
export function SettlementTape({
  bundled,
  explorer,
}: {
  bundled?: MarketReceiptsData | null;
  explorer?: string;
}) {
  const { tape, error } = useMarketReceipts();
  const ledger = tape?.data ?? bundled ?? null;
  const receipts = ledger?.receipts ?? [];
  const live = Boolean(tape?.live && tape?.data);
  const unreachable =
    error != null || tape?.upstream === "error" || tape?.upstream === "timeout";

  if (!receipts.length) {
    return (
      <div className="tape">
        <div className="tape-static">
          <span className="tape-item muted">
            {unreachable
              ? "the tape is unreachable — the press isn't answering; retrying"
              : "the tape opens with the first paid query — run `make agent`"}
          </span>
        </div>
      </div>
    );
  }

  const items = receipts.slice(0, 24).map((r) => (
    <span className="tape-item" key={`${r.seq}-${r.tx_ref}`}>
      <span className="seq">Nº {r.seq}</span>
      <AddressChip address={r.payer} explorer={explorer} copy={false} />
      <span className="amt">${r.amount_usdc.toFixed(6)}</span>
      <TxLink txRef={r.tx_ref} explorer={explorer} />
      <span className="muted">{r.scheme}</span>
    </span>
  ));

  return (
    <div className="tape" title={live ? "live settlement tape" : "simulated tape — bundled snapshot"}>
      <div className="tape-track">
        {items}
        <span aria-hidden className="tape-item muted">
          {live ? "· settled on Arc ·" : "· simulated tape ·"}
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
