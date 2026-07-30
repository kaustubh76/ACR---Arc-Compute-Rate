"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { ChainFactsStrip } from "@/components/chain/ChainFactsStrip";
import { PaymentToast, type ToastPayload } from "@/components/chain/PaymentToast";
import { SettlementTape } from "@/components/chain/SettlementTape";
import { WalletPanel } from "@/components/chain/WalletPanel";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { useEdition } from "@/lib/useEdition";
import { chainFacts } from "@/lib/chain";
import {
  useBalances,
  useBuyerReady,
  useBuyerRun,
  useCatalog,
  useMarketReceipts,
  useTerminal,
} from "@/lib/useLive";
import { fmtInt } from "@/lib/format";
import type { CatalogItem, Envelope, LiveBuyResponse, LiveBuyResult, TerminalData } from "@/lib/types";

function priceUsdc(item: CatalogItem): string {
  const atomic = item.accepts[0]?.amount ?? item.accepts[0]?.maxAmountRequired;
  return atomic && /^\d+$/.test(atomic) ? `$${(Number(atomic) / 1e6).toFixed(6)}` : "—";
}

function pathOf(resource: string): string {
  return resource.replace(/^https?:\/\/[^/]+/, "");
}

/** The unit of the index a resource is parametrized on (e.g. $/1k tokens). */
function unitOf(item: CatalogItem): string | null {
  const units = item.metadata.units;
  if (!units) return null;
  const id = Object.keys(units).find((iid) => item.resource.endsWith(`/${iid}`));
  return id ? units[id] : null;
}

export function ExchangeView({ initial }: { initial: Envelope<TerminalData> }) {
  const env = useTerminal(initial);
  const catalog = useCatalog();
  const { tape } = useMarketReceipts();
  const plain = useEdition() === "plain";

  const items = catalog?.data?.items ?? [];
  const ledger = tape?.data ?? null;
  const attestation = catalog?.data?.provider?.attestation ?? null;
  const explorer = chainFacts(env.data.chain).explorer;
  // Per-section honesty: each surface trusts ITS OWN envelope's live flag,
  // not the /terminal/data one (they can differ).
  const catalogArchived = catalog != null && !catalog.live && items.length > 0;

  // --- the floor buyer: a real x402 loop released from this page ---
  const { status: buyer, refresh: refreshBuyer } = useBuyerRun();
  const { mutate } = useSWRConfig();
  const run = buyer?.data ?? null;
  const running = run?.state === "running";
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastPayload | null>(null);
  const toastSeq = useRef(0);
  const lastDone = useRef(0);

  // Each settled query: toast the confirmation and refresh the tape/counters.
  useEffect(() => {
    if (!run || run.done === lastDone.current) return;
    lastDone.current = run.done;
    const latest = run.recent[0];
    if (run.done > 0 && latest) {
      setToast({ amountUsdc: latest.price_usdc, txRef: latest.tx_ref, key: ++toastSeq.current });
      void mutate("/api/marketplace/receipts");
      void mutate("/api/revenue");
    }
  }, [run, mutate]);

  const release = useCallback(async () => {
    setReleasing(true);
    setReleaseError(null);
    try {
      const res = await fetch("/api/demo/buyer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 20, delay_ms: 400 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setReleaseError(String(body.detail ?? `refused (${res.status})`));
      }
      await refreshBuyer();
    } catch {
      setReleaseError("the floor requires the live index API (make api)");
    } finally {
      setReleasing(false);
    }
  }, [refreshBuyer]);

  const gateIsDev = tape?.live === true && ledger?.gate === "dev";
  const gateIsCircle = tape?.live === true && ledger?.gate === "circle";

  // --- the LIVE buyer: REAL Circle Gateway settlements originated from this page
  const buyerReady = useBuyerReady();
  const { refresh: refreshBalances } = useBalances();
  const [liveRunning, setLiveRunning] = useState(false);
  const [liveResult, setLiveResult] = useState<LiveBuyResponse | null>(null);

  const releaseLive = useCallback(async () => {
    setLiveRunning(true);
    setReleaseError(null);
    setLiveResult(null);
    try {
      const res = await fetch("/api/buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 3 }),
      });
      const body = (await res.json()) as LiveBuyResponse & { detail?: string };
      if (!res.ok) {
        setReleaseError(String(body.detail ?? `refused (${res.status})`));
      } else {
        setLiveResult(body);
        const settled = (body.results ?? []).filter((r: LiveBuyResult) => r.status === 200 && r.tx_ref);
        const last = settled[settled.length - 1];
        if (last) setToast({ amountUsdc: last.price_usdc, txRef: last.tx_ref, key: ++toastSeq.current });
        void mutate("/api/marketplace/receipts");
        void mutate("/api/revenue");
        void refreshBalances();
      }
    } catch {
      setReleaseError("the live buyer needs the Circle gate reachable (and a funded buyer key)");
    } finally {
      setLiveRunning(false);
    }
  }, [mutate, refreshBalances]);

  return (
    <>
      <div className="standfirst-block" style={{ marginTop: 40 }}>
        <Ed
          as="p"
          className="standfirst"
          style={{ margin: 0 }}
          x="The exchange floor of the index: machines discover the listings, pay a nanopayment a query, and every settlement prints on the tape. Discovery is free — the data costs."
          p="The shop floor: software agents browse what’s for sale, pay a fraction of a cent per question, and every payment lands on the receipt roll below. Looking is free — answers cost."
        />
      </div>

      <section className="section">
        <div className="section-head">
          <span className="label">
            <Ed x="Listings — /marketplace/catalog" p="For sale — /marketplace/catalog" />
            {catalogArchived ? (
              <span className="muted">
                {" "}
                <Ed x="· archived edition" p="· saved copy" />
              </span>
            ) : null}
          </span>
          <span className="label">
            {tape == null || ledger == null ? (
              <span className="muted">
                <Ed x="gate — awaiting API" p="paywall — waiting for our server" />
              </span>
            ) : !tape.live ? (
              <span className="muted">
                <Ed x="archived tape · simulated gate" p="saved feed · simulated paywall" />
              </span>
            ) : ledger.gate === "circle" ? (
              <span className="green">
                <Ed x="live x402 · Circle Gateway" p="live payments · Circle Gateway" />
              </span>
            ) : (
              <span className="gold">
                <Ed x="mock gate · dev" p="practice paywall · dev" />
              </span>
            )}
          </span>
        </div>

        {items.length ? (
          <>
            <div className="table-scroll">
              <table className="sheet">
                <thead>
                  <tr>
                    <th>Resource</th>
                    <th>What it sells</th>
                    <th>
                      <Ed x="Price / query" p="Price / question" />
                    </th>
                    <th>Network</th>
                    <th>
                      <Ed x="Provenance" p="Seller proof" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.resource}>
                      <td className="mono">{pathOf(item.resource)}</td>
                      <td>
                        {item.metadata.description}
                        {unitOf(item) ? <span className="muted"> · {unitOf(item)}</span> : null}
                      </td>
                      <td className="mono">{priceUsdc(item)}</td>
                      <td className="mono">{item.accepts[0]?.network ?? "—"}</td>
                      <td>
                        {item.metadata.provider.attestation ? (
                          <span className="green">
                            <Ed x="attested" p="sworn records" /> ·{" "}
                            {item.metadata.provider.attestation.sellers_attested} sellers
                          </span>
                        ) : (
                          <span className="muted">
                            <Ed x="registry not connected" p="register not connected" />
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Ed
              as="p"
              className="muted"
              style={{ fontSize: 13, marginTop: 16, maxWidth: 68 * 9 }}
              x={
                <>
                  Each listing carries the full x402 PaymentRequirements (scheme{" "}
                  <span className="mono">exact</span>, GatewayWalletBatched) plus input/output
                  schemas — an agent decides before it pays.
                  {attestation
                    ? ` Provenance reads ${fmtInt(attestation.sellers_attested)} EIP-712 seller
                       attestations straight from the on-chain registry.`
                    : " With a deployed AttestationRegistry the listings carry on-chain seller provenance."}
                </>
              }
              p={
                <>
                  Every listing carries its full payment terms and the shape of the answer — a
                  robot shopper reads the label and decides before it pays.
                  {attestation ? (
                    <>
                      {" "}
                      The proof column reads {fmtInt(attestation.sellers_attested)}{" "}
                      <Term k="attestation">sworn seller records</Term> straight off the public
                      register.
                    </>
                  ) : (
                    <> Once the register is deployed, each listing carries its seller’s sworn record.</>
                  )}
                </>
              }
            />
          </>
        ) : (
          <div className="awaiting">
            {catalog?.live ? (
              "Awaiting the catalog —"
            ) : (
              <Ed
                x="The exchange opens with the live index API — run `make api`."
                p="The shop opens when our live server starts — run `make api`."
              />
            )}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <span className="label">
            <Ed x="The tape — /marketplace/receipts" p="The receipt roll — /marketplace/receipts" />
            {tape != null && !tape.live && ledger ? (
              <span className="muted">
                {" "}
                <Ed x="· simulated (bundled snapshot)" p="· simulated (saved copy)" />
              </span>
            ) : null}
          </span>
          {ledger ? (
            <span className="label">
              {fmtInt(ledger.paid_queries)} <Ed x="paid queries" p="paid questions" /> · $
              {ledger.revenue_usdc.toFixed(4)} USDC
            </span>
          ) : null}
        </div>

        {/* Real settlement hashes deep-link to the Arc explorer; dev-N refs
            stay plain. The tape itself marks live vs simulated. */}
        <SettlementTape bundled={ledger} explorer={explorer} />
      </section>

      <section className="section">
        <WalletPanel explorer={explorer} />
      </section>

      <section className="section">
        <div className="section-head">
          <span className="label">
            <Ed x="Run the buyer" p="Let a robot shopper loose" />
          </span>
          <span className="btn-row">
            {gateIsCircle ? (
              <button
                className="btn"
                onClick={releaseLive}
                disabled={!buyerReady?.buyer_ready || liveRunning}
                title={
                  buyerReady?.buyer_ready
                    ? plain
                      ? "3 REAL payments through Circle — it signs a digital check and money actually moves"
                      : "3 REAL Circle Gateway settlements — signs EIP-3009 and settles on Arc"
                    : plain
                      ? "add a funded buyer key (with an open Circle deposit) to enable"
                      : "set a funded ACR_BUYER_PRIVATE_KEY (with an open Gateway deposit) to enable"
                }
              >
                {liveRunning ? (
                  "settling… (real Circle)"
                ) : buyerReady?.buyer_ready ? (
                  <Ed
                    x="Release the LIVE buyer — 3 real settlements"
                    p="Let the LIVE buyer loose — 3 real payments"
                  />
                ) : (
                  "LIVE buyer — needs a funded key"
                )}
              </button>
            ) : (
              <button
                className="btn"
                onClick={release}
                disabled={!gateIsDev || running || releasing}
                title={
                  gateIsDev
                    ? plain
                      ? "20 real pay-per-question round trips through the live paywall"
                      : "20 real x402 two-act exchanges through the live gate"
                    : "needs the live dev gate (ACR_X402_MODE=dev make api)"
                }
              >
                {running ? (
                  `buying… ${run?.done}/${run?.total}`
                ) : (
                  <Ed
                    x="Release the floor buyer — 20 paid queries"
                    p="Let the robot shopper loose — 20 paid questions"
                  />
                )}
              </button>
            )}
          </span>
        </div>

        {liveResult ? (
          <p className="mono" style={{ fontSize: 13, marginTop: 0 }}>
            {liveResult.payer ? <span className="muted">{liveResult.payer} · </span> : null}
            {liveResult.results.filter((r) => r.status === 200).length}/{liveResult.results.length}{" "}
            settled · ${liveResult.spent_usdc.toFixed(6)} USDC
            <span className="muted"> (cap ${liveResult.cap_usdc})</span>
            {liveResult.results.map((r, i) => (
              <span key={i} style={{ display: "block" }}>
                {r.status === 200 ? (
                  <span className="green">✓ {r.path} → {r.tx_ref}</span>
                ) : (
                  <span className="vermilion">✗ {r.path} — {r.error ?? `status ${r.status}`}</span>
                )}
              </span>
            ))}
          </p>
        ) : null}

        {run && run.state !== "idle" ? (
          <p className="mono" style={{ fontSize: 13, marginTop: 0 }}>
            {run.state === "error" ? (
              <span className="vermilion">buyer errored — {run.error}</span>
            ) : (
              <>
                {run.payer} · {run.done}/{run.total} settled · $
                {run.spent_usdc.toFixed(6)} USDC
                {run.recent[0] ? (
                  <span className="muted">
                    {" "}
                    · last {run.recent[0].path} → {run.recent[0].tx_ref}
                  </span>
                ) : null}
                {run.state === "done" ? <span className="green"> · run complete</span> : null}
              </>
            )}
          </p>
        ) : null}
        {releaseError ? (
          <p className="mono vermilion" style={{ fontSize: 13, marginTop: 0 }}>
            {releaseError}
          </p>
        ) : null}

        <div className="table-scroll">
          <table className="sheet">
            <tbody>
              <tr>
                <td className="mono">make agent</td>
                <td>
                  <Ed
                    x={
                      <>
                        offline demo — the agent discovers the catalog and pays the mock gate (run{" "}
                        <span className="mono">ACR_X402_MODE=dev make api</span> first)
                      </>
                    }
                    p={
                      <>
                        practice run — the robot browses the shop and pays the practice paywall
                        (run <span className="mono">ACR_X402_MODE=dev make api</span> first)
                      </>
                    }
                  />
                </td>
              </tr>
              <tr>
                <td className="mono">make agent-live</td>
                <td>
                  <Ed
                    x={
                      <>
                        Arc testnet — Circle Gateway settlement via{" "}
                        <span className="mono">@circle-fin/x402-batching</span>; needs a funded{" "}
                        <span className="mono">AGENT_PRIVATE_KEY</span> (see{" "}
                        <span className="mono">docs/agent-runbook.md</span>)
                      </>
                    }
                    p={
                      <>
                        the real test network — actual Circle payments; needs a funded{" "}
                        <span className="mono">AGENT_PRIVATE_KEY</span> (see{" "}
                        <span className="mono">docs/agent-runbook.md</span>)
                      </>
                    }
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: 13, marginTop: 16, maxWidth: 68 * 9 }}
          x={
            <>
              The buyer is the other half of the marketplace: wallet, discovery, payment, receipt —
              the full agent-commerce loop against this exchange. The button above runs the same
              two-act exchange in-process; <span className="mono">apps/agent</span> is its
              out-of-process twin over real HTTP.
            </>
          }
          p={
            <>
              The buyer is the other half of the shop: wallet, browsing, payment, receipt — the
              full robot-shopping loop against this page. The button above runs it inside the
              site; <span className="mono">apps/agent</span> is its stand-alone twin over real
              HTTP.
            </>
          }
        />
      </section>

      <section className="section">
        <div className="section-head">
          <Ed x="Only computable on Arc" p="Why this only works on Arc" className="label" />
        </div>
        <ChainFactsStrip chain={env.data.chain} />
      </section>

      <PaymentToast payload={toast} explorer={explorer} />
    </>
  );
}
