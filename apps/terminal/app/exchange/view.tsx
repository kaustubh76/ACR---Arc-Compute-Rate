"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { ChainFactsStrip } from "@/components/chain/ChainFactsStrip";
import { PaymentToast, type ToastPayload } from "@/components/chain/PaymentToast";
import { SettlementTape } from "@/components/chain/SettlementTape";
import { WalletPanel } from "@/components/chain/WalletPanel";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { HedgerPanel } from "@/components/chain/HedgerPanel";
import { useEdition } from "@/lib/useEdition";
import { chainFacts } from "@/lib/chain";
import {
  useBalances,
  useBuyerReady,
  useBuyerRun,
  useCatalog,
  useHedger,
  useMarketReceipts,
  useTerminal,
} from "@/lib/useLive";
import { fmtInt } from "@/lib/format";
import type { CatalogItem, Envelope, LiveBuyResponse, LiveBuyResult, TerminalData } from "@/lib/types";

function priceUsdc(item: CatalogItem): string {
  const atomic = item.accepts[0]?.amount ?? item.accepts[0]?.maxAmountRequired;
  return atomic && /^\d+$/.test(atomic) ? `$${(Number(atomic) / 1e6).toFixed(6)}` : "…";
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
  const hedge = useHedger();
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
      setReleaseError("the floor needs the live press, which may still be waking");
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
          x="Machines discover the listings, pay a nanopayment a query, and every settlement prints on the tape. Discovery is free, the data costs."
          p="Robot shoppers browse what’s for sale, pay a fraction of a cent a question, and every receipt prints below. Looking is free, answers cost."
        />
        <Ed
          as="p"
          className="standfirst"
          style={{ margin: "8px 0 0" }}
          x="One buyer closes the loop. The print it purchases is the input to the position it takes, and the log says so."
          p="One robot shopper closes the loop. It pays for the number, then trades on it, one wallet, one log."
        />
      </div>

      <section className="section">
        <div className="section-head">
          <span className="label">
            <Ed x="Listings · /marketplace/catalog" p="For sale · /marketplace/catalog" />
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
                <Ed x="gate · awaiting API" p="paywall · waiting for our server" />
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
                      <td className="mono">{item.accepts[0]?.network ?? "…"}</td>
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
                  Each listing carries its full x402 payment terms and schemas.{" "}
                  {attestation
                    ? `Backed by ${fmtInt(attestation.sellers_attested)} EIP-712 seller attestations read from the on-chain registry.`
                    : "Seller provenance lights up with a deployed AttestationRegistry."}
                </>
              }
              p={
                <>
                  Every listing shows its price terms and the shape of the answer.{" "}
                  {attestation ? (
                    <>
                      Backed by {fmtInt(attestation.sellers_attested)}{" "}
                      <Term k="attestation">sworn seller records</Term> on the public register.
                    </>
                  ) : (
                    <>Sworn seller records appear once the register is live.</>
                  )}
                </>
              }
            />
          </>
        ) : (
          <div className="awaiting">
            {catalog?.live ? (
              "Awaiting the catalog"
            ) : (
              <Ed
                x="The exchange opens when the press answers. The free-tier press wakes on first visit (~60s) and this page retries by itself."
                p="The shop opens when our server wakes up. It naps between visits to save money, and this page keeps trying on its own."
              />
            )}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <span className="label">
            <Ed x="The tape · /marketplace/receipts" p="The receipt roll · /marketplace/receipts" />
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
                      ? "3 REAL payments through Circle: it signs a digital check and money actually moves"
                      : "3 REAL Circle Gateway settlements: signs EIP-3009 and settles on Arc"
                    : plain
                      ? "this copy of the site has no funded demo shopper"
                      : "no funded demo buyer is configured on this deployment"
                }
              >
                {liveRunning ? (
                  <Ed x="settling… (real Circle)" p="paying… (really)" />
                ) : buyerReady?.buyer_ready ? (
                  <Ed
                    x="Release the LIVE buyer · 3 real settlements"
                    p="Let the LIVE buyer loose · 3 real payments"
                  />
                ) : (
                  <Ed x="LIVE buyer · unavailable here" p="LIVE buyer · not available here" />
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
                    : plain
                    ? "the shop's till is asleep: this wakes with the server"
                    : "the paid gate is not answering: this opens when the press does"
                }
              >
                {running ? (
                  `buying… ${run?.done}/${run?.total}`
                ) : (
                  <Ed
                    x="Release the floor buyer · 20 paid queries"
                    p="Let the robot shopper loose · 20 paid questions"
                  />
                )}
              </button>
            )}
          </span>
        </div>

        {/* Why the button above is grey, in words, on the page.
            A `title` never fires on a phone, and a greyed-out invitation with
            no visible reason reads as broken software. Two different causes,
            two different sentences — and neither names a config variable at a
            reader who cannot set one. Crucially, both say what is STILL true:
            the tape below is the real record either way. */}
        {gateIsCircle && !buyerReady?.buyer_ready ? (
          <p className="muted" style={{ fontSize: 13, marginTop: 0, maxWidth: 68 * 9 }}>
            <Ed
              x="This deployment carries no funded demo buyer, so the button above is closed. Nothing else here is affected. The settlement tape below is the real, on-chain record of payments that already happened."
              p="This copy of the site has no demo shopper with money, so that button is off; everything else works and the payments below really happened."
            />
          </p>
        ) : null}
        {!gateIsCircle && !gateIsDev ? (
          <p className="muted" style={{ fontSize: 13, marginTop: 0, maxWidth: 68 * 9 }}>
            <Ed
              x="The paid gate is not answering yet, so the buyer cannot run. The free-tier press wakes on first visit (~60s) and this page retries by itself. The tape below is the archived record until it does."
              p="Our server is waking up (about a minute), so the shopper waits; this page keeps trying and the payments below are real ones from before."
            />
          </p>
        ) : null}

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
                  <span className="vermilion">✗ {r.path} · {r.error ?? `status ${r.status}`}</span>
                )}
              </span>
            ))}
          </p>
        ) : null}

        {run && run.state !== "idle" ? (
          <p className="mono" style={{ fontSize: 13, marginTop: 0 }}>
            {run.state === "error" ? (
              <span className="vermilion">buyer errored · {run.error}</span>
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
          <p className="mono vermilion" style={{ fontSize: 13, marginTop: 0 }} role="alert">
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
                        offline demo · the agent pays the mock gate (run{" "}
                        <span className="mono">ACR_X402_MODE=dev make api</span> first)
                      </>
                    }
                    p={
                      <>
                        practice run · the robot pays the practice paywall (run{" "}
                        <span className="mono">ACR_X402_MODE=dev make api</span> first)
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
                        Arc testnet · real Circle Gateway settlement; needs a funded{" "}
                        <span className="mono">AGENT_PRIVATE_KEY</span> (see{" "}
                        <span className="mono">docs/agent-runbook.md</span>)
                      </>
                    }
                    p={
                      <>
                        the real test network · actual Circle payments; needs a funded{" "}
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
              The button runs the buyer’s whole loop (discover, pay, receipt) in-process;{" "}
              <span className="mono">apps/agent</span> is its twin over real HTTP.
            </>
          }
          p={
            <>
              The button runs a whole robot shopping trip (browse, pay, receipt) inside this
              site; <span className="mono">apps/agent</span> is its stand-alone twin.
            </>
          }
        />
      </section>

      {/* The loop this page argues for, actually closed. Everything above is a
          machine BUYING the print; this is the machine that then trades a real
          on-chain future on what it read. useHedger shares its SWR key with
          /curve, so mounting it here costs no extra request. */}
      <section className="section">
        <div className="section-head">
          <Ed
            x="…and what a machine does with what it bought"
            p="…and what a robot does with what it bought"
            className="label"
          />
        </div>
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: 13, marginTop: 0, maxWidth: 68 * 9 }}
          x="The hedger pays for the print above, then trades the on-chain future on what it read: one agent, both sides of the marketplace."
          p="This robot pays for the rate above, then trades a real contract on what it learned: one agent, both halves of the shop."
        />
      </section>
      <HedgerPanel
        state={hedge.hedger?.data ?? null}
        live={Boolean(hedge.hedger?.live)}
        explorer={explorer}
      />

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
