"use client";

import { useState } from "react";
import { TickerNumber } from "@/components/TickerNumber";
import { ApiConsole } from "@/components/ApiConsole";
import { WebhookActivity } from "@/components/WebhookActivity";
import { WalletPanel } from "@/components/chain/WalletPanel";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { chainFacts } from "@/lib/chain";
import { useRevenue, useTerminal, useX402Info } from "@/lib/useLive";
import { fmtInt, money, shortAddr } from "@/lib/format";
import { INDICES, PRICE_FALLBACK_USDC } from "@/lib/indices";
import type { Envelope, TerminalData } from "@/lib/types";

// method, path, gate, description, plain description, console-loadable path
// (null = not queryable here)
const ENDPOINTS: Array<[string, string, string, string, string, string | null]> = [
  ["GET", "/prints", "x402", "All latest prints + CI + attack cost", "Every current rate, its wiggle room, and the cost to bend it", "/prints"],
  ["GET", "/prints/{index_id}", "x402", "One index, with diagnostics", "One rate, with its health checks", `/prints/${INDICES[0]}`],
  ["GET", "/curve/{index_id}", "x402", "Term structure (A-S mids by tenor)", "Forward prices, week by week", `/curve/${INDICES[0]}`],
  ["GET", "/vol/{index_id}", "x402", "Realized annualized vol", "How jumpy the price has been (yearly figure)", `/vol/${INDICES[0]}`],
  ["GET", "/seller-scores/{index_id}", "x402", "Seller reliability", "Which sellers to trust", `/seller-scores/${INDICES[0]}`],
  ["GET", "/", "public", "Service card — indices, pricing, marketplace pointers", "The menu — what is sold here and for how much", null],
  ["GET", "/onchain/{index_id}", "public", "Settlement-grade print from ACROracle", "The official rate, read off the blockchain", null],
  ["GET", "/marketplace/catalog", "public", "Machine-readable listings (Bazaar-shaped)", "The shop's listings, in a shape robots can read", null],
  ["GET", "/marketplace/receipts", "public", "The settlement tape — recent x402 receipts", "The receipt roll — who paid for what", null],
  ["GET", "/terminal/data", "public", "The human terminal feed (this site)", "Everything this website shows, as data", null],
  ["POST", "/demo/attack/start", "public", "Kick a live wash-attack run (Attack Lab)", "Start a live cheating attempt (the lab)", null],
  ["GET", "/demo/attack/status", "public", "Attack run progress + verdict", "How the cheating attempt is going", null],
  ["POST", "/demo/buyer/start", "public", "Release the floor buyer (Exchange demo)", "Let the robot shopper loose (shop demo)", null],
  ["GET", "/demo/buyer/status", "public", "Floor-buyer run progress", "How the robot shopper is doing", null],
  ["GET", "/revenue", "public", "Paid queries + revenue (the dogfood metric)", "Questions paid for + money earned", null],
  ["GET", "/x402/info", "public", "The payment gate, described", "How the paywall works, in plain data", null],
  ["POST", "/webhooks/circle", "public", "Inbound Circle webhook receiver (signed)", "Where Circle reports each settled payment", null],
  ["GET", "/webhooks/recent", "public", "Recent Circle webhook events", "Circle's latest payment reports", null],
  ["GET", "/health", "public", "Liveness", "Is the server awake?", null],
  // The Public Desk. All POST, so the console (which replays GETs) can't load
  // them — but an integrator still needs to know the surface exists.
  ["POST", "/desk/session", "public", "Open/resume a Circle user-controlled wallet session", "Start your own wallet on the trading desk", null],
  ["POST", "/desk/wallet", "public", "That session's SCA + its USDC stake", "Your desk wallet and what's in it", null],
  ["POST", "/desk/faucet", "public", "Drip the one-per-wallet testnet stake", "Get the 50-cent test stake, once per wallet", null],
  ["POST", "/desk/limits", "public", "Live per-direction size caps (both margin checks)", "The biggest trade you could place right now", null],
  ["POST", "/desk/withdrawable", "public", "What this wallet can take back out, per series", "How much of your money you can take back", null],
  ["POST", "/desk/challenge", "public", "Mint a PIN challenge: approve / collateral / trade / withdraw", "Ask for the PIN prompt that authorizes one action", null],
];

export function DevelopersView({ initial }: { initial: Envelope<TerminalData> }) {
  const env = useTerminal(initial);
  const { revenue, refresh } = useRevenue();
  const rev = revenue?.data;
  const info = useX402Info();
  // The gate's live advertised price (ACR_X402_PRICE_USDC) — what is PAID.
  const price = info?.data?.price_usdc ?? rev?.price_usdc ?? PRICE_FALLBACK_USDC;
  // The gate column tracks what the press actually charges for: the live
  // /x402/info gated_endpoints list (bundled x402 section offline) wins over
  // the authored value, so a re-gated endpoint can't silently lie here.
  const gated = info?.data?.gated_endpoints;
  const gateFor = (path: string, authored: string) =>
    Array.isArray(gated) && gated.length ? (gated.includes(path) ? "x402" : "public") : authored;
  const explorer = chainFacts(env.data.chain).explorer;
  const [loadPath, setLoadPath] = useState<string | null>(null);

  return (
    <>
      <div className="standfirst-block" style={{ marginTop: 40 }}>
        <Ed
          as="p"
          className="standfirst"
          style={{ margin: 0 }}
          x="The index about machine commerce is bought by machines — every query is a Nanopayment."
          p="Sold the way it is made, machine to machine — software pays a fraction of a cent a question, no account, no API key."
        />
      </div>

      <div style={{ marginTop: 32 }}>
        <div className="rb-value" style={{ fontSize: "clamp(30px, 3.6vw, 44px)" }}>
          ${price}{" "}
          <span style={{ color: "var(--ink-45)", fontWeight: 400 }}>
            <Ed x="/ query" p="/ question" />
          </span>
        </div>
        <div className="rb-unit">
          <Ed
            x="x402 · USDC on Arc · pay-per-print, no keys, no accounts"
            p={
              <>
                pay-per-answer in digital dollars — the web’s{" "}
                <Term k="x402">“402 Payment Required”</Term> standard
              </>
            }
          />
        </div>
      </div>

      <ApiConsole
        live={env.live}
        externalPath={loadPath}
        onRevenue={refresh}
        sample={env.data.x402_exchange_sample ?? null}
      />

      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 13, marginTop: 12, maxWidth: 68 * 9 }}
        x={
          <>
            On the dev gate the console pays a mock header; on the{" "}
            <span className="mono">circle</span> gate, <b>Settle for real</b> signs EIP-3009 and
            settles through Circle Gateway.
          </>
        }
        p={
          <>
            In practice mode the console pays a stand-in token; on the real paywall,{" "}
            <b>Settle for real</b> <Term k="eip3009">signs a digital check</Term> and real money
            moves.
          </>
        }
      />

      <section className="section">
        <WalletPanel explorer={explorer} />
      </section>

      <section className="section">
        <div className="section-head">
          <Ed x="Machine revenue — live" p="What machines have paid us — live" className="label" />
        </div>
        <div className="lab-counters">
          <div>
            <div className="counter-value">
              <TickerNumber text={fmtInt(rev?.paid_queries ?? 0)} />
            </div>
            <div className="counter-label label">
              <Ed x="Paid queries" p="Questions paid for" />
            </div>
          </div>
          <div>
            <div className="counter-value gold">
              <TickerNumber text={money(rev?.revenue_usdc ?? 0, 4)} />
            </div>
            <div className="counter-label label">
              <Ed x="Revenue (USDC)" p="Revenue (dollars)" />
            </div>
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
            <Ed
              x="No receipts yet this session — run a query above and it prints here."
              p="No receipts yet this session — ask a question above and it prints here."
            />
          </p>
        )}
      </section>

      <WebhookActivity />

      <section className="section">
        <div className="section-head">
          <Ed x="Endpoints" p="What you can ask" className="label" />
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
                <th>
                  <Ed x="Gate" p="Cost" />
                </th>
                <th>Returns</th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.map(([method, path, gate, desc, plainDesc, load]) => (
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
                    {gateFor(path, gate) === "x402" ? (
                      <span className="gold">
                        <Ed x={<>402 · ${price}</>} p={<>${price} to ask</>} />
                      </span>
                    ) : (
                      <span className="muted">
                        <Ed x="public" p="free" />
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: "left" }} className="muted">
                    <Ed x={desc} p={plainDesc} />
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
