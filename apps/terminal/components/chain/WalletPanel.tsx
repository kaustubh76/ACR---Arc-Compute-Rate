"use client";

/* Live Circle Gateway wallet standings — the buyer's deposit ticks down and the
   seller's USDC climbs as real settlements land. Powered by /api/circle/balances
   (the funded buyer key, server-side). Degrades to a quiet note when no buyer is
   configured or the seller is on the dev gate. */

import { AddressChip } from "@/components/chain/AddressChip";
import { useBalances } from "@/lib/useLive";
import type { WalletBalance } from "@/lib/types";

function Amount({ value, unit = "USDC" }: { value: string | null; unit?: string }) {
  if (value == null) return <span className="muted mono">—</span>;
  return (
    <span className="mono" style={{ color: "var(--sand)" }}>
      {value} <span className="muted" style={{ fontSize: 12 }}>{unit}</span>
    </span>
  );
}

function WalletRow({ w, explorer }: { w: WalletBalance; explorer?: string }) {
  const isBuyer = w.role === "buyer";
  return (
    <div className="wallet-row">
      <div className="wallet-role">
        <span className="label">{isBuyer ? "Buyer — pays" : "Seller — pay_to"}</span>
        <AddressChip address={w.address} explorer={explorer} />
      </div>
      <div className="wallet-figures">
        {isBuyer && w.gateway ? (
          <>
            <span title="spendable Gateway deposit (gasless x402 draws from here)">
              <span className="chip chip-teal">Gateway</span> <Amount value={w.gateway.available} />
            </span>
            <span className="muted mono" style={{ fontSize: 12 }}>
              total {w.gateway.total}
              {Number(w.gateway.withdrawing) > 0 ? ` · ${w.gateway.withdrawing} mid-batch` : ""}
            </span>
            <span className="muted mono" style={{ fontSize: 12 }}>
              wallet {w.usdc ?? "—"} USDC
            </span>
          </>
        ) : (
          <span title="USDC received by the seller (native gas token on Arc)">
            <span className="chip chip-gold">received</span> <Amount value={w.usdc} />
          </span>
        )}
      </div>
    </div>
  );
}

export function WalletPanel({ explorer }: { explorer?: string }) {
  const { balances, error } = useBalances();
  const data = balances?.data ?? null;
  const ready = data?.buyer_ready === true && (data?.wallets.length ?? 0) > 0;
  const note = error
    ? "Balances are unreachable right now — the terminal keeps retrying; standings resume automatically."
    : data?.note ??
      "Connect a funded buyer (ACR_BUYER_PRIVATE_KEY) against the Circle gate to watch the Gateway deposit draw down in real time.";

  return (
    <div className="panel panel-pad wallet-panel">
      <div className="section-head" style={{ marginTop: 0 }}>
        <span className="label">
          Circle Gateway wallets
          {ready ? <span className="green"> · live</span> : null}
        </span>
        {ready ? (
          <span className="chip chip-teal">
            <i className="dot breathe" /> settling on Arc
          </span>
        ) : null}
      </div>

      {ready ? (
        <div className="wallet-grid">
          {data!.wallets.map((w) => (
            <WalletRow key={`${w.role}-${w.address}`} w={w} explorer={explorer} />
          ))}
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>
          {note}
        </p>
      )}
    </div>
  );
}
