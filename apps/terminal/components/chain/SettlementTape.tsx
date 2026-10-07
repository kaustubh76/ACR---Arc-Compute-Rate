"use client";

import { useMarketReceipts } from "@/lib/useLive";
import { useEdition } from "@/lib/useEdition";
import { AddressChip } from "./AddressChip";
import { TxLink } from "./TxLink";
import { Ed } from "@/components/Ed";
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
  const plain = useEdition() === "plain";
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
            {unreachable ? (
              <Ed
                x="the tape is unreachable: the press isn't answering; retrying"
                p="the receipt roll is unreachable: our server isn't answering; retrying"
              />
            ) : (
              <Ed
                x="the tape opens with the first paid query · run `make agent`"
                p="the receipt roll opens with the first paid question · run `make agent`"
              />
            )}
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
      {/* The tier the buyer's card earned, on the receipt itself. Gold for a
          purchase the chain ties to a person, teal for a signed key; nothing for
          anonymous or for rows older than the gate, which look identical and are
          not the same fact. */}
      {r.tier === "human" ? (
        <span className="chip chip-gold" title={plain ? "bought by a wallet traced to a real person" : "settled under the human tier: the payer's card named a cluster HumanIdMirror confirms"}>
          <Ed x="human" p="person" />
        </span>
      ) : r.tier === "carded" ? (
        <span className="chip chip-teal" title={plain ? "bought by a robot that showed a signed ID card" : "settled under the carded tier: a signed AGENT-CARD, budget keyed on its key"}>
          <Ed x="carded" p="signed" />
        </span>
      ) : null}
    </span>
  ));

  return (
    <div
      className="tape"
      title={
        live
          ? plain
            ? "the live receipt roll"
            : "live settlement tape"
          : plain
            ? "simulated receipts · saved copy"
            : "simulated tape · bundled snapshot"
      }
    >
      <div className="tape-track">
        {items}
        <span aria-hidden className="tape-item muted">
          {live ? (
            "· settled on Arc ·"
          ) : (
            <Ed x="· simulated tape ·" p="· simulated receipts ·" />
          )}
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
