"use client";

import { Fragment, useCallback, useState } from "react";
import { TickerNumber } from "@/components/TickerNumber";
import { ApiConsole } from "@/components/ApiConsole";
import { AgentCardSnippet } from "@/components/chain/AgentCardSnippet";
import { HumanProof } from "@/components/chain/HumanProof";
import { WebhookActivity } from "@/components/WebhookActivity";
import { WalletPanel } from "@/components/chain/WalletPanel";
import { ContractRegister } from "@/components/chain/ContractRegister";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { chainFacts } from "@/lib/chain";
import { useMarketReceipts, useRevenue, useTerminal, useX402Info } from "@/lib/useLive";
import { fmtInt, money, shortAddr } from "@/lib/format";
import { PRICE_FALLBACK_USDC } from "@/lib/indices";
import { ENDPOINTS, FAMILIES, type EndpointRow, type Family } from "@/lib/endpoints";
import type { Envelope, MarketReceipt, TerminalData } from "@/lib/types";

/** What /api/probe answers with. `detail` replaces the rest on a refusal or a
 *  press that did not wake in time. */
interface ProbeResult {
  path: string;
  status?: number;
  ms?: number;
  body?: string;
  truncated?: boolean;
  detail?: string;
  /** Only /agent/whoami answers with one. Parsed server-side so the page does not
   *  read it back out of a truncated preview string. */
  tier?: string;
  carded?: boolean;
}

/** The three ways to run /agent/whoami, and the key each result is stored under.
 *  Three slots rather than one, so a reader can see anonymous, carded and human
 *  side by side — the comparison IS the demonstration. */
type CardSlot = "" | "#card" | "#human";

const TIER_CHIP: Record<string, string> = { anonymous: "chip chip-sim", carded: "chip chip-teal", human: "chip chip-gold" };

/* What each route sells, keyed by the register's path.
 *
 * Kept here as JSX rather than beside the paths in lib/endpoints.ts, and the
 * reason is a gate rather than taste: coverage.test.ts counts edition markers
 * and lints `p="…"` only under app/ and components/, so this copy moved into a
 * .ts would stop being counted and stop being checked for banned jargon.
 * ContractRegister's GLOSS map sits here for the same reason. chain.test.ts
 * asserts every register path has an entry, so the two halves cannot drift. */
const DESC: Record<string, React.ReactNode> = {
  "/prints": <Ed x="All latest prints + CI + attack cost" p="Every current rate, its wiggle room, and the cost to bend it" />,
  "/prints/{index_id}": <Ed x="One index, with diagnostics" p="One rate, with its health checks" />,
  "/curve/{index_id}": <Ed x="Term structure (A-S mids by tenor)" p="Forward prices, week by week" />,
  "/vol/{index_id}": <Ed x="Realized annualized vol" p="How jumpy the price has been (yearly figure)" />,
  "/seller-scores/{index_id}": <Ed x="Seller reliability" p="Which sellers to trust" />,
  "/": <Ed x="Service card · indices, pricing, marketplace pointers" p="The menu · what is sold here and for how much" />,
  "/onchain/{index_id}": <Ed x="Settlement-grade print from ACROracle" p="The official rate, read off the blockchain" />,
  "/futures": <Ed x="The whole venue · every desk and the on-chain fill tape" p="The trading desk and every recent trade" />,
  "/futures/{index_id}": <Ed x="One index's live series, read from ACRFutures" p="One market's trading desk, read off the blockchain" />,
  "/marketplace/catalog": <Ed x="Machine-readable listings (Bazaar-shaped)" p="The shop's listings, in a shape robots can read" />,
  "/marketplace/receipts": <Ed x="The settlement tape · recent receipts" p="The receipt roll · who paid for what" />,
  "/terminal/data": <Ed x="The human terminal feed (this site)" p="Everything this website shows, as data" />,
  "/tca/{payer}": <Ed x="What one wallet paid, against the rate it could have seen" p="What one wallet paid, next to the fair rate at the time" />,
  "/rating/{seller}": <Ed x="A seller's grade, its parts, and how much of the scoring it covers" p="A seller's score, what went into it, and how complete it is" />,
  "/tca/human": <Ed x="One bill across every wallet a verified human owns" p="One bill covering all the accounts that belong to the same person" />,
  "/humanid/info": <Ed x="The human-proof gate, described by the service itself" p="How we check someone is a real person, in the service's own words" />,
  "/agent/info": <Ed x="The agent-card gate, described by the service itself" p="How we check which robot is calling, in the service's own words" />,
  "/agent/challenge": <Ed x="Everything an agent needs to mint a card: domain, roles, and the lifetime bound" p="The instructions a robot needs to make itself an ID card" />,
  "/agent/whoami": <Ed x="What the gate made of the card you presented, and which of the three tiers it reached" p="Who we think you are, and whether we could confirm a real person behind it" />,
  "/armor/info": <Ed x="The screen on agent-to-agent traffic: which backend answered, and where it is applied" p="The filter on robot-to-robot messages, and which one is switched on" />,
  "/hedger": <Ed x="The autonomous hedger's standing: mandate, position, fills, and spend" p="How the automatic trader is doing: what it may do, what it holds, what it has spent" />,
  "/graph/operations": <Ed x="The named reads the tape proxy will run" p="The list of questions you may ask the record" />,
  "/graph/query": <Ed x="Run one named read against the indexed tape" p="Ask the record one of those questions" />,
  "/fleet": <Ed x="The seller listings, each with its own price and payee" p="Who is selling, at what price, paid to which wallet" />,
  "/demo/attack/start": <Ed x="Kick a live wash-attack run (Attack Lab)" p="Start a live cheating attempt (the lab)" />,
  "/demo/attack/status": <Ed x="Attack run progress + verdict" p="How the cheating attempt is going" />,
  "/demo/buyer/start": <Ed x="Release the floor buyer (Exchange demo)" p="Let the robot shopper loose (shop demo)" />,
  "/demo/buyer/status": <Ed x="Floor-buyer run progress" p="How the robot shopper is doing" />,
  "/revenue": <Ed x="Paid queries + revenue (the dogfood metric)" p="Questions paid for + money earned" />,
  "/x402/info": <Ed x="The payment gate, described" p="How the paywall works, in plain data" />,
  "/webhooks/circle": <Ed x="Inbound Circle webhook receiver (signed)" p="Where Circle reports each settled payment" />,
  "/webhooks/recent": <Ed x="Recent Circle webhook events" p="Circle's latest payment reports" />,
  "/health": <Ed x="Liveness" p="Is the server awake?" />,
  "/desk/session": <Ed x="Open/resume a Circle user-controlled wallet session" p="Start your own wallet on the trading desk" />,
  "/desk/wallet": <Ed x="That session's SCA + its USDC stake" p="Your desk wallet and what's in it" />,
  "/desk/faucet": <Ed x="Drip the one-per-wallet testnet stake" p="Get the 50-cent test stake, once per wallet" />,
  "/desk/limits": <Ed x="Live per-direction size caps (both margin checks)" p="The biggest trade you could place right now" />,
  "/desk/withdrawable": <Ed x="What this wallet can take back out, per series" p="How much of your money you can take back" />,
  "/desk/challenge": <Ed x="Mint a PIN challenge: approve / collateral / trade / withdraw" p="Ask for the PIN prompt that authorizes one action" />,
};

/** Settlements the tape can attribute to a documented path.
 *
 *  Template-aware, and that is the whole difficulty: the register documents
 *  `/prints/{index_id}` while a receipt records the concrete `/prints/ACR-INF`,
 *  so a plain equality would attribute nothing. Matches the placeholder against
 *  one path segment only, so `/prints/{index_id}` never swallows `/prints`.
 *
 *  A row with none prints nothing rather than 0: the seller only began stamping
 *  the bought path partway through, so most archived receipts carry no resource
 *  at all, and "the tape cannot say" is a different claim from "nobody bought
 *  it". Same rule the exchange listings follow. */
function salesFor(path: string, receipts: MarketReceipt[] | undefined): MarketReceipt[] {
  const re = new RegExp("^" + path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{index_id\\}", "[^/]+") + "$");
  return (receipts ?? []).filter((r) => r.resource && re.test(r.resource));
}

/** The heading over each family. */
const FAMILY_HEAD: Record<Family, React.ReactNode> = {
  paid: <Ed x="Paid · the index itself" p="Paid · the rates themselves" />,
  venue: <Ed x="The venue · free to read" p="The market · free to read" />,
  market: <Ed x="The marketplace · free to read" p="The shop · free to read" />,
  demo: <Ed x="The demos" p="The demos" />,
  desk: <Ed x="The public desk · session required" p="Your own wallet · needs a session" />,
  ops: <Ed x="Operations" p="Housekeeping" />,
};

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
  const c = chainFacts(env.data.chain);
  const explorer = c.explorer;
  const [loadPath, setLoadPath] = useState<string | null>(null);

  /* --- the endpoints table, made answerable ---
     Twenty-two of the twenty-seven rows were inert, and every one of those is
     a FREE route: nothing was stopping a reader from calling them except the
     absence of a button. Now each runnable row fetches through /api/probe and
     shows what came back, so the table is evidence rather than documentation.

     `selected` also fixes a quieter defect: clicking a paid row set two
     dropdowns inside a console five sections above the table, with no scroll
     and no feedback, so the click was a no-op from where the reader was
     sitting. That is most of why this section read as static. */
  const [selected, setSelected] = useState<string | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [probeOut, setProbeOut] = useState<Record<string, ProbeResult>>({});
  const { tape } = useMarketReceipts();

  const loadIntoConsole = useCallback((path: string, run: string) => {
    setSelected(path);
    setLoadPath(run + "#" + Date.now());
    // The console is above the table and the reader is not. Bring it to them.
    document.getElementById("console")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const probe = useCallback(
    async (path: string, run: string, slot: CardSlot = "", extra: Record<string, unknown> = {}) => {
      setSelected(path);
      setProbing(path + slot);
      try {
        const res = await fetch("/api/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: run, ...extra }),
        });
        const body = (await res.json()) as ProbeResult & { detail?: string };
        setProbeOut((o) => ({ ...o, [path + slot]: body }));
      } catch {
        setProbeOut((o) => ({
          ...o,
          [path + slot]: { path: run, detail: "could not reach the press from here. Press again" },
        }));
      } finally {
        setProbing(null);
      }
    },
    [],
  );

  /* A card signed in THIS TAB. The key is generated here, used once, and dropped
     with the component: it never touches storage and never leaves the browser
     unsigned, which is the whole point of showing a reader they can mint their own.
     Audience and chain come from the gate's own challenge, never from a constant,
     so a card minted on this page is a card the gate will actually read. */
  const mintAndProbe = useCallback(async (path: string, run: string) => {
    setSelected(path);
    setProbing(path + "#card");
    try {
      const chRes = await fetch("/api/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/agent/challenge" }),
      });
      const ch = (await chRes.json()) as ProbeResult;
      const parsed = ch.body ? (JSON.parse(ch.body) as { audience?: string; chain_id?: number }) : {};
      const { mintCard, throwawayKey } = await import("@/lib/agentcard");
      const minted = await mintCard({
        privateKey: await throwawayKey(),
        chainId: Number(parsed.chain_id ?? c.chainId),
        audience: String(parsed.audience ?? "acr-index-api"),
        name: "acr-developers-page",
        role: "reader",
      });
      setProbing(null);
      await probe(path, run, "#card", { agent_card: minted.header });
    } catch {
      setProbeOut((o) => ({
        ...o,
        [path + "#card"]: { path: run, detail: "could not mint a card in this tab. Press again" },
      }));
      setProbing(null);
    }
  }, [probe, c.chainId]);

  /** One handler for both kinds of row. A paid path goes to the console, which
   *  shows the 402 before anything is paid; a free one runs right here. */
  const fire = (e: EndpointRow) => {
    if (e.console) loadIntoConsole(e.path, e.console);
    else if (e.run) void probe(e.path, e.run);
  };

  return (
    <>
      <div className="standfirst-block" style={{ marginTop: 40 }}>
        <Ed
          as="p"
          className="standfirst"
          style={{ margin: 0 }}
          x="The index about machine commerce is bought by machines. Every query is a Nanopayment."
          p="Sold the way it is made, machine to machine. Software pays a fraction of a cent a question, no account, no API key."
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
                pay-per-answer in digital dollars · the web’s{" "}
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
        prints={env.data.prints}
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

      {/* The other gate. The console above shows the 402 before a cent moves;
          this shows the 401 before a person is admitted. Same page, same move,
          and they belong next to each other: the register two sections down now
          carries a row whose only explanation is "needs a proof of personhood",
          and this is where a reader finds out what that means. */}
      <HumanProof />
      {/* The agent gate's sibling section: the same "ask it what it wants", and then
          the code to satisfy it, in three languages, derived from that answer. The
          snippets name the PUBLIC host because that is the one an agent would call;
          without NEXT_PUBLIC_ACR_API at build time they name the dev loopback. */}
      <AgentCardSnippet api={process.env.NEXT_PUBLIC_ACR_API ?? "http://127.0.0.1:8000"} />

      {/* The contracts, named where a developer looks for them. This page knew
          the chain well enough to build explorer links and never once said
          what it was linking to — so FeedAccessAttestor, which turns a paid
          query into an on-chain right, existed with nothing anywhere pointing
          at it. The list itself now lives in ContractRegister, shared with the
          footer, because this hand-rolled copy had already drifted from it:
          no USDC, no Gateway wallet, no plain edition for the glosses. */}
      <section className="section anchor-target" id="register">
        <div className="section-head">
          <Ed x="The contracts" p="The public record" className="label" />
          <a className="section-link" href="/ops">
            <Ed x="systems ledger →" p="is it working? →" />
          </a>
        </div>
        <ContractRegister chain={env.data.chain} oracleFallback={env.data.oracle} />
      </section>

      <section className="section">
        <WalletPanel explorer={explorer} />
      </section>

      <section className="section">
        <div className="section-head">
          <Ed x="Machine revenue · live" p="What machines have paid us · live" className="label" />
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
              x="No receipts yet this session. Run a query above and it prints here."
              p="No receipts yet this session. Ask a question above and it prints here."
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
                <th>
                  <Ed x="Try" p="Try" />
                </th>
              </tr>
            </thead>
            <tbody>
              {FAMILIES.map((fam) => {
                const rows = ENDPOINTS.filter((e) => e.family === fam);
                if (!rows.length) return null;
                return (
                  <Fragment key={fam}>
                    {/* Twenty-seven rows in one flat list, ordered by nothing a
                        reader could see. The families were already there in the
                        paths; they just were not drawn. */}
                    <tr>
                      <td colSpan={5} style={{ paddingTop: 18, borderBottom: 0 }}>
                        <span className="label">{FAMILY_HEAD[fam]}</span>
                      </td>
                    </tr>
                    {rows.map((e) => {
                      const paid = gateFor(e.path, e.gate) === "x402";
                      const isSel = selected === e.path;
                      const out = probeOut[e.path];
                      // A paid row goes to the console (it has to show the 402
                      // before anything is paid); a free row runs right here.
                      const act = e.console ? "console" : e.run ? "probe" : null;
                      const sold = paid ? salesFor(e.path, tape?.data?.receipts).length : 0;
                      return (
                        <Fragment key={e.path}>
                          <tr
                            className={act ? "row-link" : undefined}
                            role={act ? "button" : undefined}
                            tabIndex={act ? 0 : undefined}
                            aria-current={isSel ? "true" : undefined}
                            aria-label={
                              act === "console"
                                ? `load ${e.path} into the console`
                                : act === "probe"
                                  ? `call ${e.path} now`
                                  : undefined
                            }
                            onClick={act ? () => fire(e) : undefined}
                            onKeyDown={
                              act
                                ? (ev) => {
                                    if (ev.key === "Enter" || ev.key === " ") {
                                      ev.preventDefault();
                                      fire(e);
                                    }
                                  }
                                : undefined
                            }
                          >
                            <td className="mono">{e.method}</td>
                            <td className="mono" style={{ fontWeight: 600 }}>
                              {/* The caret, not a dimmed arrow. The old marker
                                  was className="muted", so the one interactive
                                  glyph in the row was its lowest-contrast
                                  character. */}
                              {act ? <span aria-hidden>{isSel ? "▾ " : "▸ "}</span> : null}
                              {e.path}
                            </td>
                            <td>
                              {paid ? (
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
                              {DESC[e.path]}
                            </td>
                            <td className="mono">
                              {act === "probe" ? (
                                <>
                                  <button
                                    className="mini-btn"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      void probe(e.path, e.run!);
                                    }}
                                    disabled={probing !== null}
                                  >
                                    {probing === e.path ? "…" : "run"}
                                  </button>
                                  {e.path === "/agent/whoami" ? (
                                    <>
                                      {" "}
                                      <button
                                        className="mini-btn"
                                        onClick={(ev) => {
                                          ev.stopPropagation();
                                          void mintAndProbe(e.path, e.run!);
                                        }}
                                        disabled={probing !== null}
                                        title="Generate a throwaway key in this tab, sign a card with it, and present it"
                                      >
                                        {probing === e.path + "#card" ? "…" : "mint a card"}
                                      </button>{" "}
                                      <button
                                        className="mini-btn"
                                        onClick={(ev) => {
                                          ev.stopPropagation();
                                          void probe(e.path, e.run!, "#human", { as: "demo-human" });
                                        }}
                                        disabled={probing !== null}
                                        title="A card for one of the demo fleet's wallets, claiming the cluster the chain records for it"
                                      >
                                        {probing === e.path + "#human" ? "…" : "as a demo human"}
                                      </button>
                                    </>
                                  ) : null}
                                </>
                              ) : act === "console" ? (
                                <span className="muted">
                                  {sold > 0 ? (
                                    <span className="green">{fmtInt(sold)} sold</span>
                                  ) : (
                                    <Ed x="console ↑" p="try it ↑" />
                                  )}
                                </span>
                              ) : (
                                // Not a button that could only ever fail — and
                                // the right reason, not one blanket sentence:
                                // the webhook is Circle calling us, and the
                                // demo starters just want a body.
                                <span className="muted" style={{ fontSize: 11.5 }}>
                                  {e.why === "inbound" ? (
                                    <Ed x="Circle calls this" p="Circle calls this" />
                                  ) : e.why === "post" ? (
                                    <Ed x="POST · needs a body" p="needs a form filled in" />
                                  ) : e.why === "address" ? (
                                    <Ed x="needs a wallet in the path" p="needs a wallet address" />
                                  ) : e.why === "human" ? (
                                    <Ed x="needs a proof of personhood" p="needs proof you are a real person" />
                                  ) : (
                                    <Ed x="needs a session" p="needs a session" />
                                  )}
                                </span>
                              )}
                            </td>
                          </tr>
                          {(["", "#card", "#human"] as CardSlot[]).map((slot) => {
                            const o = slot === "" ? out : probeOut[e.path + slot];
                            if (!o) return null;
                            return (
                              <tr key={e.path + slot}>
                                <td colSpan={5} style={{ paddingTop: 0 }}>
                                  {o.detail ? (
                                    <p className="mono muted" role="status" style={{ fontSize: 12.5, margin: "0 0 10px" }}>
                                      {o.detail}
                                    </p>
                                  ) : (
                                    <>
                                      <p className="mono" style={{ fontSize: 12.5, margin: "0 0 6px" }}>
                                        <span className={o.status === 200 ? "green" : "gold"}>
                                          {o.status}
                                        </span>{" "}
                                        <span className="muted">
                                          · {fmtInt(o.ms ?? 0)} ms
                                          {o.truncated ? " · preview" : ""}
                                        </span>
                                        {/* The tier, as a badge, because this row exists to make the
                                            three tiers visible next to each other. The sentence after
                                            it is the one the human tier was built to say. */}
                                        {o.tier ? (
                                          <>
                                            {" "}
                                            <span className={TIER_CHIP[o.tier] ?? "chip"}>{o.tier}</span>{" "}
                                            <span className="muted">
                                              {slot === "#card" ? (
                                                <Ed x="signed in this tab, with a key that dies with it" p="an ID card made right here, thrown away after" />
                                              ) : slot === "#human" ? (
                                                <Ed x="a demo wallet the chain ties to a person: one budget for every wallet they own" p="a test wallet the chain knows belongs to a person, so it shares one allowance with their other wallets" />
                                              ) : o.tier === "anonymous" ? (
                                                <Ed x="no card, so the shared ceiling" p="no ID card, so the limit everyone shares" />
                                              ) : null}
                                            </span>
                                          </>
                                        ) : null}
                                      </p>
                                      <div className="specimen" style={{ marginBottom: 10 }}>
                                        <pre style={{ maxHeight: 220, overflow: "auto" }}>{o.body}</pre>
                                      </div>
                                    </>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
