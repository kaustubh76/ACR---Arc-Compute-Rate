"use client";

/* Live Circle Gateway wallet standings — the buyer's deposit ticks down and the
   seller's USDC climbs as real settlements land. Powered by /api/circle/balances
   (the funded buyer key, server-side). Degrades to a quiet note when no buyer is
   configured or the seller is on the dev gate. */

import { AddressChip } from "@/components/chain/AddressChip";
import { Ed } from "@/components/Ed";
import { useBalances } from "@/lib/useLive";
import { useEdition } from "@/lib/useEdition";
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
  const plain = useEdition() === "plain";
  return (
    <div className="wallet-row">
      <div className="wallet-role">
        <span className="label">
          {isBuyer ? "Buyer — pays" : <Ed x="Seller — pay_to" p="Seller — gets paid" />}
        </span>
        <AddressChip address={w.address} explorer={explorer} />
      </div>
      <div className="wallet-figures">
        {isBuyer && w.gateway ? (
          <>
            <span
              title={
                plain
                  ? "spendable deposit held at Circle — each paid question draws from here, no extra fees needed"
                  : "spendable Gateway deposit (gasless x402 draws from here)"
              }
            >
              <span className="chip chip-teal">
                <Ed x="Gateway" p="deposit" />
              </span>{" "}
              <Amount value={w.gateway.available} />
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
          <span
            title={
              plain
                ? "dollars received by the seller (the same coin also pays this network’s fees)"
                : "USDC received by the seller (native gas token on Arc)"
            }
          >
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

  return (
    <div className="panel panel-pad wallet-panel">
      <div className="section-head" style={{ marginTop: 0 }}>
        <span className="label">
          <Ed x="Circle Gateway wallets" p="Circle wallets — who pays, who gets paid" />
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
          {error ? (
            <Ed
              x="Balances are unreachable right now — the terminal keeps retrying automatically."
              p="Balances are unreachable right now — this page keeps retrying automatically."
            />
          ) : (
            data?.note ?? (
              <Ed
                x="This deployment carries no funded demo buyer, so there is no deposit to watch draw down. The balances above are real."
                p="This copy of the site has no demo shopper with money in it, so there is nothing to watch spend. The amounts above are real."
              />
            )
          )}
        </p>
      )}
    </div>
  );
}
