"use client";

import { useState } from "react";
import { TickerNumber } from "@/components/TickerNumber";
import { ApiConsole } from "@/components/ApiConsole";
import { WebhookActivity } from "@/components/WebhookActivity";
import { WalletPanel } from "@/components/chain/WalletPanel";
import { chainFacts } from "@/lib/chain";
import { useRevenue, useTerminal, useX402Info } from "@/lib/useLive";
import { fmtInt, money, shortAddr } from "@/lib/format";
import { INDICES, PRICE_FALLBACK_USDC } from "@/lib/indices";
import type { Envelope, TerminalData } from "@/lib/types";

// method, path, gate, description, console-loadable path (null = not queryable here)
const ENDPOINTS: Array<[string, string, string, string, string | null]> = [
  ["GET", "/prints", "x402", "All latest prints + CI + attack cost", "/prints"],
  ["GET", "/prints/{index_id}", "x402", "One index, with diagnostics", `/prints/${INDICES[0]}`],
  ["GET", "/curve/{index_id}", "x402", "Term structure (A-S mids by tenor)", `/curve/${INDICES[0]}`],
  ["GET", "/vol/{index_id}", "x402", "Realized annualized vol", `/vol/${INDICES[0]}`],
  ["GET", "/seller-scores/{index_id}", "x402", "Seller reliability", `/seller-scores/${INDICES[0]}`],
  ["GET", "/", "public", "Service card — indices, pricing, marketplace pointers", null],
  ["GET", "/onchain/{index_id}", "public", "Settlement-grade print from ACROracle", null],
  ["GET", "/marketplace/catalog", "public", "Machine-readable listings (Bazaar-shaped)", null],
  ["GET", "/marketplace/receipts", "public", "The settlement tape — recent x402 receipts", null],
  ["GET", "/terminal/data", "public", "The human terminal feed (this site)", null],
  ["POST", "/demo/attack/start", "public", "Kick a live wash-attack run (Attack Lab)", null],
  ["GET", "/demo/attack/status", "public", "Attack run progress + verdict", null],
  ["POST", "/demo/buyer/start", "public", "Release the floor buyer (Exchange demo)", null],
  ["GET", "/demo/buyer/status", "public", "Floor-buyer run progress", null],
  ["GET", "/revenue", "public", "Paid queries + revenue (the dogfood metric)", null],
  ["GET", "/x402/info", "public", "The payment gate, described", null],
  ["POST", "/webhooks/circle", "public", "Inbound Circle webhook receiver (signed)", null],
  ["GET", "/webhooks/recent", "public", "Recent Circle webhook events", null],
  ["GET", "/health", "public", "Liveness", null],
];

export function DevelopersView({ initial }: { initial: Envelope<TerminalData> }) {
  const env = useTerminal(initial);
  const { revenue, refresh } = useRevenue();
  const rev = revenue?.data;
  const info = useX402Info();
  // The gate's live advertised price (ACR_X402_PRICE_USDC) — what is PAID.
  const price = info?.data?.price_usdc ?? rev?.price_usdc ?? PRICE_FALLBACK_USDC;
  const explorer = chainFacts(env.data.chain).explorer;
  const [loadPath, setLoadPath] = useState<string | null>(null);

  return (
    <>
      <div className="standfirst-block" style={{ marginTop: 40 }}>
        <p className="standfirst" style={{ margin: 0 }}>
          The index about machine commerce is bought by machines — every query is a Nanopayment.
        </p>
      </div>

      <div style={{ marginTop: 32 }}>
        <div className="rb-value" style={{ fontSize: "clamp(30px, 3.6vw, 44px)" }}>
          ${price} <span style={{ color: "var(--ink-45)", fontWeight: 400 }}>/ query</span>
        </div>
        <div className="rb-unit">x402 · USDC on Arc · pay-per-print, no keys, no accounts</div>
      </div>

      <ApiConsole live={env.live} externalPath={loadPath} onRevenue={refresh} />

      <p className="muted" style={{ fontSize: 13, marginTop: 12, maxWidth: 68 * 9 }}>
        On the dev gate the console pays a mock header; on the <span className="mono">circle</span>{" "}
        gate, with a funded buyer configured, <b>Settle for real</b> signs an EIP-3009 authorization
        and settles through Circle Gateway right here. The same buyer runs as a batch from the{" "}
        <a href="/exchange">Exchange</a>, and <span className="mono">apps/agent</span> (
        <span className="mono">make agent-live</span>) is its out-of-process twin.
      </p>

      <section className="section">
        <WalletPanel explorer={explorer} />
      </section>

      <section className="section">
        <div className="section-head">
          <span className="label">Machine revenue — live</span>
        </div>
        <div className="lab-counters">
          <div>
            <div className="counter-value">
              <TickerNumber text={fmtInt(rev?.paid_queries ?? 0)} />
            </div>
            <div className="counter-label label">Paid queries</div>
          </div>
          <div>
            <div className="counter-value gold">
              <TickerNumber text={money(rev?.revenue_usdc ?? 0, 4)} />
            </div>
            <div className="counter-label label">Revenue (USDC)</div>
          </div>
        </div>
        {rev?.recent?.length ? (
          <div className="table-scroll" style={{ marginTop: 20 }}>
            <table className="sheet">
              <thead>
                <tr>
                  <th>Payer</th>
                  <th>Amount (USDC)</th>
                  <th>Ref</th>
                </tr>
              </thead>
              <tbody>
                {rev.recent
                  .slice()
                  .reverse()
                  .map((r, i) => (
                    <tr key={`${r.tx_ref}-${i}`}>
                      <td className="mono">{shortAddr(r.payer)}</td>
                      <td>{r.amount_usdc.toFixed(4)}</td>
                      <td className="muted mono">{shortAddr(r.tx_ref)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
            No receipts yet this session — run a query above and it prints here.
          </p>
        )}
      </section>

      <WebhookActivity />

      <section className="section">
        <div className="section-head">
          <span className="label">Endpoints</span>
          {/* NEXT_PUBLIC_ACR_API is inlined at build time — without it there is
              no honest public docs URL, so render nothing rather than ship a
              localhost link to production visitors. */}
          {env.live && process.env.NEXT_PUBLIC_ACR_API && (
            <a
              className="section-link"
              href={`${process.env.NEXT_PUBLIC_ACR_API}/docs`}
              target="_blank"
              rel="noreferrer"
            >
              OpenAPI →
            </a>
          )}
        </div>
        <div className="table-scroll">
          <table className="sheet">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Gate</th>
                <th>Returns</th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.map(([method, path, gate, desc, load]) => (
                <tr
                  key={path}
                  className={load ? "row-link" : undefined}
                  role={load ? "button" : undefined}
                  tabIndex={load ? 0 : undefined}
                  aria-label={load ? `load ${path} into the console` : undefined}
                  onClick={load ? () => setLoadPath(load + "#" + Date.now()) : undefined}
                  onKeyDown={
                    load
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setLoadPath(load + "#" + Date.now());
                          }
                        }
                      : undefined
                  }
                  title={load ? "load into the console above" : undefined}
                >
                  <td>{method}</td>
                  <td className="mono" style={{ fontWeight: 600 }}>
                    {path}
                    {load && <span className="muted"> ↑</span>}
                  </td>
                  <td>
                    {gate === "x402" ? (
                      <span className="gold">402 · ${price}</span>
                    ) : (
                      <span className="muted">public</span>
                    )}
                  </td>
                  <td style={{ textAlign: "left" }} className="muted">
                    {desc}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
