"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { AddressChip } from "@/components/chain/AddressChip";
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
import { fmtPrice, shortAddr } from "@/lib/format";
import type {
  CatalogItem,
  Envelope,
  LiveBuyResponse,
  LiveBuyResult,
  MarketReceipt,
  TerminalData,
} from "@/lib/types";

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

/** The top-level field names a listing returns, from its own JSON Schema.
 *
 *  The footnote under this table has always promised that every listing
 *  "carries its full x402 payment terms and schemas". The terms were on the
 *  wire and half-rendered; the schemas were on the wire and rendered nowhere,
 *  so the sentence was a promise the table broke. This is the cheapest honest
 *  way to keep it: the names of what you get, before you pay for it.
 */
function returnsFields(item: CatalogItem): string[] {
  const out = item.metadata.output as { properties?: Record<string, unknown> } | undefined;
  const props = out?.properties;
  return props && typeof props === "object" ? Object.keys(props) : [];
}

/** Settlements the tape can attribute to one listing, newest first.
 *
 *  "Cannot attribute" is not "never sold": the seller only began stamping the
 *  bought path onto a receipt partway through, so most archived rows carry no
 *  resource at all and every caller has to say so rather than print a zero.
 */
function salesFor(resource: string, receipts: MarketReceipt[] | undefined): MarketReceipt[] {
  const path = pathOf(resource);
  return (receipts ?? []).filter((r) => r.resource && pathOf(r.resource) === path);
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

  /* --- buying ONE listing, the one the reader opened ---
     The button above releases the buyer at `{count: 3}` with no paths, so it
     has never bought the listing anybody was looking at: the catalog and the
     purchase were two unrelated things on one page. /api/buy already takes
     `paths`, and lib/buyPlan's allowlist is exactly these thirteen resources,
     so the storefront was one argument away the whole time. Same route, same
     two spend caps, one query instead of three. */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [buyOut, setBuyOut] = useState<Record<string, LiveBuyResult>>({});
  const [buyErr, setBuyErr] = useState<Record<string, string>>({});

  const buyOne = useCallback(
    async (resource: string) => {
      const path = pathOf(resource);
      setBuying(path);
      setBuyErr((e) => ({ ...e, [path]: "" }));
      try {
        const res = await fetch("/api/buy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ count: 1, paths: [path] }),
        });
        const body = (await res.json()) as LiveBuyResponse & { detail?: string };
        if (!res.ok) {
          setBuyErr((e) => ({ ...e, [path]: String(body.detail ?? `refused (${res.status})`) }));
          return;
        }
        const r = body.results?.[0] ?? null;
        if (r) setBuyOut((o) => ({ ...o, [path]: r }));
        if (r && r.status === 200 && r.tx_ref) {
          setToast({ amountUsdc: r.price_usdc, txRef: r.tx_ref, key: ++toastSeq.current });
          // The three surfaces this purchase just changed. Without these the
          // reader has to reload to see their own settlement, which is the
          // whole thing this page is trying to prove.
          void mutate("/api/marketplace/receipts");
          void mutate("/api/revenue");
          void refreshBalances();
        } else if (r?.error) {
          setBuyErr((e) => ({ ...e, [path]: r.error as string }));
        }
      } catch {
        setBuyErr((e) => ({ ...e, [path]: "could not reach the buyer from here. Press again" }));
      } finally {
        setBuying(null);
      }
    },
    [mutate, refreshBalances],
  );

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
          x="One buyer closes the loop. It pays for the print, and the venue fills its trade at that same print, so the position below is what it paid for."
          p="One robot shopper closes the loop. It pays for the number, and the market trades at that same number, so it holds what it paid for."
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
            {/* Stated once, where it is true. It used to be a column repeating
                the identical string on all thirteen rows, because the same
                provider object is embedded in every item: it describes the
                seller, not any one listing. */}
            {attestation ? (
              <span className="muted">
                <Ed x="seller " p="seller " />
                {fmtInt(attestation.sellers_attested)}
                <Ed x=" attested on-chain · " p=" sworn records on the blockchain · " />
              </span>
            ) : null}
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
                    {/* The Provenance column used to sit here printing
                        "attested · 4 sellers" on all thirteen rows: every item
                        embeds the same provider object, so it described the
                        seller, not the listing. It is stated once in the head
                        note instead. Network went the same way (identical on
                        every row) and now lives inside the open row, beside
                        the rest of the payment terms it belongs with. */}
                    <th>
                      <Ed x="Sold" p="Bought" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const path = pathOf(item.resource);
                    const open = expanded === path;
                    const terms = item.accepts[0];
                    const sales = salesFor(item.resource, ledger?.receipts);
                    const out = buyOut[path];
                    const err = buyErr[path];
                    return (
                      <Fragment key={item.resource}>
                        <tr
                          className="row-link"
                          role="button"
                          tabIndex={0}
                          aria-expanded={open}
                          aria-label={`show the payment terms for ${path}`}
                          onClick={() => setExpanded(open ? null : path)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setExpanded(open ? null : path);
                            }
                          }}
                        >
                          <td className="mono">
                            <span className="muted">{open ? "▾" : "▸"}</span> {path}
                          </td>
                          <td>
                            {item.metadata.description}
                            {unitOf(item) ? <span className="muted"> · {unitOf(item)}</span> : null}
                          </td>
                          <td className="mono">{priceUsdc(item)}</td>
                          {/* An unattributed listing prints nothing, never 0:
                              the tape only names the resource on settlements
                              recorded since the seller began stamping it, so a
                              zero here would say "nobody bought this" when the
                              truth is "this tape cannot say". */}
                          <td className="mono">
                            {sales.length ? (
                              <span className="green">{fmtInt(sales.length)}</span>
                            ) : (
                              <span className="muted">·</span>
                            )}
                          </td>
                        </tr>
                        {open ? (
                          <tr>
                            <td colSpan={4} style={{ paddingTop: 0 }}>
                              <div className="provenance" style={{ padding: "4px 0 14px" }}>
                                <div className="provenance-row">
                                  <span className="label">
                                    <Ed x="you pay" p="you pay" />
                                  </span>
                                  <span className="val">
                                    {priceUsdc(item)} <span className="muted">USDC</span>
                                    {terms ? (
                                      <span className="muted">
                                        {" "}
                                        · {terms.scheme} · {terms.network}
                                      </span>
                                    ) : null}
                                  </span>
                                </div>
                                <div className="provenance-row">
                                  <span className="label">
                                    <Ed x="paid to" p="money goes to" />
                                  </span>
                                  <span className="val">
                                    {terms?.payTo ? (
                                      <AddressChip address={terms.payTo} explorer={explorer} />
                                    ) : (
                                      "…"
                                    )}
                                  </span>
                                </div>
                                <div className="provenance-row">
                                  <span className="label">
                                    <Ed x="settled through" p="handled by" />
                                  </span>
                                  <span className="val">
                                    {(terms?.extra as { name?: string } | undefined)?.name ??
                                      "Gateway"}
                                    {(terms?.extra as { verifyingContract?: string } | undefined)
                                      ?.verifyingContract ? (
                                      <span className="muted">
                                        {" "}
                                        ·{" "}
                                        {shortAddr(
                                          (terms!.extra as { verifyingContract: string })
                                            .verifyingContract,
                                        )}
                                      </span>
                                    ) : null}
                                  </span>
                                </div>
                                {returnsFields(item).length ? (
                                  <div className="provenance-row">
                                    <span className="label">
                                      <Ed x="you get back" p="you get back" />
                                    </span>
                                    <span className="val">{returnsFields(item).join(" · ")}</span>
                                  </div>
                                ) : null}
                                {item.lastUpdated ? (
                                  <div className="provenance-row">
                                    <span className="label">
                                      <Ed x="listed since" p="on sale since" />
                                    </span>
                                    <span className="val">
                                      {item.lastUpdated.replace("T", " ").slice(0, 16)} UTC
                                    </span>
                                  </div>
                                ) : null}
                                {sales.length ? (
                                  <div className="provenance-row">
                                    <span className="label">
                                      <Ed x="last settlement" p="last sale" />
                                    </span>
                                    <span className="val">
                                      {sales[0].tx_ref.slice(0, 8)}…{" "}
                                      <span className="muted">
                                        {fmtPrice(sales[0].amount_usdc, 2)} USDC
                                      </span>
                                    </span>
                                  </div>
                                ) : null}
                              </div>

                              {/* The whole point: buy THIS one. Same route and
                                  the same two spend caps as the button below,
                                  one query instead of three. */}
                              <div className="btn-row" style={{ marginBottom: 10 }}>
                                <button
                                  className="btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void buyOne(item.resource);
                                  }}
                                  disabled={!buyerReady?.buyer_ready || buying !== null}
                                >
                                  {buying === path ? (
                                    <Ed x="settling…" p="paying…" />
                                  ) : (
                                    <>
                                      <Ed x="buy this one" p="buy this one" /> · {priceUsdc(item)}
                                    </>
                                  )}
                                </button>
                                {!buyerReady?.buyer_ready ? (
                                  <span className="muted" style={{ fontSize: 12.5 }}>
                                    <Ed
                                      x="this deployment has no funded buyer key, so nothing here can settle"
                                      p="this copy of the site has no funded shopper, so it cannot buy"
                                    />
                                  </span>
                                ) : null}
                              </div>

                              {out && out.status === 200 ? (
                                <p className="mono green" style={{ fontSize: 12.5, margin: 0 }}>
                                  ✓ {fmtPrice(out.price_usdc, 2)} USDC · {out.tx_ref}
                                </p>
                              ) : null}
                              {err ? (
                                <p
                                  className="mono vermilion"
                                  role="alert"
                                  style={{ fontSize: 12.5, margin: 0, maxWidth: 68 * 9 }}
                                >
                                  {err}
                                </p>
                              ) : null}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Ed
              as="p"
              className="muted"
              style={{ fontSize: 13, marginTop: 16, maxWidth: 68 * 9 }}
              x={
                <>
                  Open a listing for the x402 terms the gate itself enforces, and buy it here: one
                  query, settled through Circle Gateway, capped. The Sold column counts settlements
                  the tape can name, and it can only name the ones recorded since the seller began
                  stamping the bought path onto each receipt.
                </>
              }
              p={
                <>
                  Open any row to see its price terms and what you get back, then buy just that one.
                  The Bought column counts only sales our receipt list can trace to a listing, so a
                  blank means we cannot say, not that nobody bought it.
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
          /curve, so mounting it here costs no extra request.

          One head, not two. HedgerPanel carries its own `.section-head` inside
          its card — the WalletPanel mount 200 lines up is built the same way —
          so this section is a bare 56px wrapper. A head here AND in the panel
          drew two hairlines and two gold accent bars, 56px apart, for one
          subject, with a single sentence stranded between them. That head's
          copy now opens the deck below instead of being repeated. */}
      <section className="section">
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: 13, margin: "0 0 14px", maxWidth: 68 * 9 }}
          x="…and what a machine does with what it bought: it pays for the print above, then trades the on-chain future on what it read, one agent on both sides of the marketplace."
          p="…and what a robot does with what it bought: it pays for the rate above, then trades a real contract on what it learned."
        />
        <HedgerPanel
          state={hedge.hedger?.data ?? null}
          live={Boolean(hedge.hedger?.live)}
          explorer={explorer}
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
