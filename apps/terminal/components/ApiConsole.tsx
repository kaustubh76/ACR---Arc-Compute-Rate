"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useBuyerReady, useX402Info } from "@/lib/useLive";
import { refKind } from "@/lib/chain";
import { INDICES, PRICE_FALLBACK_USDC, isIndexId } from "@/lib/indices";
import { Ed } from "@/components/Ed";
import { QuoteCorridor } from "@/components/charts/QuoteCorridor";
import { fmt, fmtInt, fmtPrice } from "@/lib/format";
import type {
  ConsoleResult,
  ExchangeSample,
  LiveBuyResponse,
  LiveBuyResult,
  PrintRow,
} from "@/lib/types";

type EndpointKind = "prints-all" | "prints" | "curve" | "vol" | "seller-scores";
const ENDPOINTS: Array<{ kind: EndpointKind; label: string; parameterized: boolean }> = [
  { kind: "prints-all", label: "all prints", parameterized: false },
  { kind: "prints", label: "print", parameterized: true },
  { kind: "curve", label: "curve", parameterized: true },
  { kind: "vol", label: "vol", parameterized: true },
  { kind: "seller-scores", label: "seller-scores", parameterized: true },
];

function pathFor(kind: EndpointKind, index: string): string {
  if (kind === "prints-all") return "/prints";
  return `/${kind}/${index}`;
}

// Deterministic initial payer so SSR and hydration render identically; each
// mount then draws a fresh random id in an effect, and ↻ redraws.
const INITIAL_PAYER = "0xagent-3a18f6";

function randPayer(): string {
  // regex-safe: 0x + 6 hex chars, no ":" or whitespace.
  const hex = "0123456789abcdef";
  let s = "0xagent-";
  for (let i = 0; i < 6; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

function statusClass(status: number): string {
  if (status === 200) return "green";
  if (status === 402) return "gold";
  return "vermilion";
}

/** What the selected endpoint SELLS, drawn from the free feed.
 *
 *  Switching to `curve` or `vol` used to change the request line and nothing
 *  else: with no query run, the console rendered nothing at all below the
 *  status row, and with a stale one it showed the previous endpoint's JSON
 *  under the new endpoint's label. Either way the control read as broken.
 *
 *  The honest fix is that we already publish these shapes for free. Every
 *  `PrintRow` on the terminal feed carries `curve` and `vol` verbatim — the
 *  same arrays and scalars the paid routes return. So the console can show a
 *  reader exactly what they are about to buy, and the paid call then proves
 *  the gate rather than the data. */
function ShapePreview({
  kind,
  index,
  prints,
}: {
  kind: EndpointKind;
  index: string;
  prints: Record<string, PrintRow>;
}) {
  const print = prints[index];
  if (!print) return null;

  if (kind === "curve") {
    if (!print.curve?.length) return null;
    return (
      <div className="console-preview">
        <div className="label" style={{ marginBottom: 10 }}>
          <Ed x={`Shape · ${index} term structure`} p={`Shape · ${index} prices ahead`} />
        </div>
        <QuoteCorridor prints={prints} only={index} />
        <div className="table-scroll" style={{ marginTop: 10 }}>
          <table className="sheet">
            <thead>
              <tr>
                <th>
                  <Ed x="tenor" p="weeks out" />
                </th>
                <th>
                  <Ed x="bid" p="buy at" />
                </th>
                <th>
                  <Ed x="mid" p="middle" />
                </th>
                <th>
                  <Ed x="ask" p="sell at" />
                </th>
                <th>
                  <Ed x="spread" p="gap" />
                </th>
              </tr>
            </thead>
            <tbody>
              {print.curve.map((c) => (
                <tr key={c.tenor_weeks}>
                  <td className="mono">{c.tenor_weeks}w</td>
                  <td className="mono">{fmtPrice(c.bid)}</td>
                  <td className="mono gold">{fmtPrice(c.mid)}</td>
                  <td className="mono">{fmtPrice(c.ask)}</td>
                  <td className="mono">{fmtInt(c.spread_bp)} bp</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (kind === "vol") {
    return (
      <div className="console-preview">
        <div className="label" style={{ marginBottom: 10 }}>
          <Ed x={`Shape · ${index} realized volatility`} p={`Shape · how much ${index} moves`} />
        </div>
        <div className="lab-counters">
          <div>
            <div className="counter-value gold" style={{ fontSize: 30 }}>
              {fmt(100 * print.vol, 1)}%
            </div>
            <div className="counter-label label">
              <Ed x="annualized, from the print history" p="over a year, from past rates" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function pretty(v: unknown, cap = 24): { text: string; truncated: boolean } {
  const full = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  const lines = full.split("\n");
  if (lines.length <= cap) return { text: full, truncated: false };
  return { text: lines.slice(0, cap).join("\n"), truncated: true };
}

export function ApiConsole({
  live,
  externalPath,
  onRevenue,
  sample,
  prints,
}: {
  live: boolean;
  externalPath?: string | null;
  onRevenue: () => void;
  /** recorded two-act exchange from the bundle — shown while the gate is offline */
  sample?: ExchangeSample | null;
  /** The free terminal feed. Carries `curve` and `vol` verbatim, so the console
   *  can show the shape of what the selected endpoint sells without paying. */
  prints: Record<string, PrintRow>;
}) {
  const info = useX402Info();
  const mode = info?.data?.facilitator; // "dev" | "circle" | undefined
  const gateLive = info ? info.live : live;
  const buyerReady = useBuyerReady();

  // Real Circle settlement (circle gate + funded buyer): completes the loop the
  // dev mock can't — a genuine EIP-3009 sign + Gateway settle, gateway-ref back.
  const [liveOut, setLiveOut] = useState<LiveBuyResult | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveErr, setLiveErr] = useState<string | null>(null);

  const [kind, setKind] = useState<EndpointKind>("prints-all");
  const [index, setIndex] = useState<string>(INDICES[0]);
  const [payer, setPayer] = useState(INITIAL_PAYER);
  useEffect(() => setPayer(randPayer()), []); // per-visitor identity, post-hydration
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConsoleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [tally, setTally] = useState({ n: 0, usdc: 0 });
  const [agentOn, setAgentOn] = useState(false);

  const current = ENDPOINTS.find((e) => e.kind === kind) ?? ENDPOINTS[0];
  const path = pathFor(kind, index);

  // A clicked endpoint row elsewhere on the page loads that path here. Callers
  // append "#<nonce>" so clicking the same row twice re-fires this effect.
  // Both segments are validated — a malformed path is ignored, never applied.
  useEffect(() => {
    if (!externalPath) return;
    const clean = externalPath.split("#")[0];
    if (clean === "/prints") setKind("prints-all");
    else {
      const [, k, idx] = clean.split("/");
      if (ENDPOINTS.some((e) => e.kind === k)) setKind(k as EndpointKind);
      if (idx && isIndexId(idx)) setIndex(idx);
    }
  }, [externalPath]);

  const runQuery = useCallback(
    async (p: string) => {
      const res = await fetch("/api/console", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: p, payer }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.detail ?? `console error ${res.status}`);
      return json as ConsoleResult;
    },
    [payer],
  );

  const query = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await runQuery(path);
      setResult(r);
      setExpanded(false);
      if (r.paid) {
        setTally((t) => ({ n: t.n + 1, usdc: t.usdc + (info?.data?.price_usdc ?? PRICE_FALLBACK_USDC) }));
        onRevenue();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "query failed");
    } finally {
      setBusy(false);
    }
  }, [path, runQuery, onRevenue, info]);

  // Complete the loop for real against Circle: sign + settle a single query
  // through the funded Gateway buyer, and surface the real gateway-ref/tx.
  const settleReal = useCallback(async () => {
    setLiveBusy(true);
    setLiveErr(null);
    setLiveOut(null);
    try {
      const res = await fetch("/api/buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 1, paths: [path] }),
      });
      const body = (await res.json()) as LiveBuyResponse & { detail?: string };
      if (!res.ok) throw new Error(body.detail ?? `settle failed ${res.status}`);
      const r = body.results?.[0] ?? null;
      setLiveOut(r);
      if (r && r.status === 200) {
        setTally((t) => ({ n: t.n + 1, usdc: t.usdc + r.price_usdc }));
        onRevenue();
      } else if (r?.error) {
        setLiveErr(r.error);
      }
    } catch (e) {
      setLiveErr(e instanceof Error ? e.message : "settlement failed");
    } finally {
      setLiveBusy(false);
    }
  }, [path, onRevenue]);

  // Demo agent: one paid query every 4s, rotating endpoints. Enabled only when
  // live + dev gate. In-flight ref prevents a slow exchange from overlapping.
  const inFlight = useRef(false);
  const rotor = useRef(0);
  useEffect(() => {
    if (!agentOn) return;
    const id = setInterval(async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      const ep = ENDPOINTS[rotor.current % ENDPOINTS.length];
      rotor.current += 1;
      const p = pathFor(ep.kind, INDICES[rotor.current % INDICES.length]);
      try {
        const r = await runQuery(p);
        if (r.paid) {
          setTally((t) => ({ n: t.n + 1, usdc: t.usdc + (info?.data?.price_usdc ?? PRICE_FALLBACK_USDC) }));
          onRevenue();
        }
      } catch {
        /* keep the agent running through transient errors */
      } finally {
        inFlight.current = false;
      }
    }, 4000);
    return () => clearInterval(id);
  }, [agentOn, runQuery, onRevenue, info]);

  const agentAllowed = gateLive && mode === "dev";
  useEffect(() => {
    if (!agentAllowed && agentOn) setAgentOn(false);
  }, [agentAllowed, agentOn]);

  return (
    /* `id` + anchor-target: the endpoints table sits five sections below this
       and hands a path up to it. Without a scroll target, clicking a row set
       two dropdowns the reader could not see and looked like nothing at all. */
    <section className="section anchor-target" id="console">
      <div className="section-head">
        <Ed
          x="The wire · query the index"
          p="Ask the index a question · pay for the answer"
          className="label"
        />
        {mode && (
          <span className={`gate-badge ${mode === "dev" ? "gold" : "green"}`}>
            {mode === "dev" ? <Ed x="◆ DEV GATE" p="◆ PRACTICE PAYWALL" /> : "◆ CIRCLE GATEWAY"}
          </span>
        )}
      </div>

      <div className="console">
        <div className="console-controls">
          {/* Changing the endpoint clears the last answer. It used to leave it
              mounted, so the request line read `GET /curve/ACR-INF` above a
              `/prints` payload until the reader paid again — the console
              quietly showing one endpoint's data under another's name. */}
          <div className="segmented" role="group" aria-label="endpoint">
            {ENDPOINTS.map((e) => (
              <button
                key={e.kind}
                type="button"
                className={e.kind === kind ? "on" : ""}
                aria-pressed={e.kind === kind}
                onClick={() => {
                  setKind(e.kind);
                  setResult(null);
                  setLiveOut(null);
                  setError(null);
                  setExpanded(false);
                }}
              >
                {e.label}
              </button>
            ))}
          </div>
          {current.parameterized && (
            <div className="segmented" role="group" aria-label="index">
              {INDICES.map((i) => (
                <button
                  key={i}
                  type="button"
                  className={i === index ? "on" : ""}
                  aria-pressed={i === index}
                  onClick={() => {
                    setIndex(i);
                    setResult(null);
                    setLiveOut(null);
                    setError(null);
                    setExpanded(false);
                  }}
                >
                  {i.replace("ACR-", "")}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="console-req">
          <span className="mono muted">GET</span>{" "}
          <span className="mono" style={{ fontWeight: 600 }}>
            {path}
          </span>
          <span className="console-payer">
            <span className="label">as</span>
            <span className="mono">{payer}</span>
            <button className="mini-btn" onClick={() => setPayer(randPayer())} title="new agent id">
              ↻
            </button>
          </span>
        </div>

        {/* The `resource` in the challenge below is the live API host, which is a
            different domain from this dashboard by design — not a stale link. */}
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}
          x={
            <>
              The <span className="mono">resource</span> in the challenge below is the live API
              endpoint a machine pays for. It is a different domain from this dashboard by design.
            </>
          }
          p={
            <>
              The <span className="mono">resource</span> in the paywall notice below is the live
              address a robot pays to use. It is a different domain from this dashboard on purpose.
            </>
          }
        />

        {/* What the selected endpoint sells, free, before anyone pays for it. */}
        <ShapePreview kind={kind} index={index} prints={prints} />
        {kind === "curve" || kind === "vol" ? (
          <Ed
            as="p"
            className="muted"
            style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}
            x="The shape above is the free copy of exactly what this endpoint returns. Paying buys it with its own signed record of where it came from."
            p="The picture above is the free copy of what this endpoint answers with. Paying buys it with a signed note of where it came from."
          />
        ) : null}

        <div className="console-actions">
          <button className="btn" onClick={query} disabled={!gateLive || busy}>
            {busy ? (
              "Paying…"
            ) : (
              <Ed
                x={`Pay $${info?.data?.price_usdc ?? PRICE_FALLBACK_USDC} & query`}
                p={`Pay $${info?.data?.price_usdc ?? PRICE_FALLBACK_USDC} & ask`}
              />
            )}
          </button>
          {agentAllowed && (
            <label className="agent-toggle">
              <input type="checkbox" checked={agentOn} onChange={(e) => setAgentOn(e.target.checked)} />
              <span className="label">
                <Ed x="Demo agent · 1 query / 4s" p="Demo robot · 1 question / 4s" />
              </span>
            </label>
          )}
          {(tally.n > 0 || agentOn) && (
            <span className="label console-tally">
              {tally.n} paid · ${tally.usdc.toFixed(4)} this session
            </span>
          )}
        </div>

        {/* always-reserved status line — messages swap in without shoving the
            results block below */}
        <div className="label" style={{ marginTop: 8, minHeight: 18 }} aria-live="polite">
          {!gateLive ? (
            <Ed
              x="The gate is offline. Below is a RECORDED exchange from the archived edition."
              p="The paywall is offline. Below is a RECORDED exchange from the saved copy."
            />
          ) : error ? (
            <span className="vermilion">{error}</span>
          ) : null}
        </div>

        {/* Offline: the bundled recorded two-act exchange, honestly labeled —
            the console never renders as an empty dead panel. */}
        {!gateLive && !result && sample && (
          <div className="console-out">
            <div className="specimen">
              <div className="act-head">
                <span className="label">
                  <Ed x="Act I · challenge (recorded)" p="Act I · the turnstile asks (recorded)" />
                </span>
                <span className={`mono ${statusClass(sample.challenge.status)}`}>
                  {sample.challenge.status} {sample.challenge.status === 402 ? "Payment Required" : ""}
                </span>
              </div>
              <pre>
                {Object.entries(sample.challenge.headers)
                  .map(([k, v]) => `${k}: ${String(v).length > 96 ? String(v).slice(0, 96) + "…" : v}`)
                  .join("\n")}
              </pre>
            </div>
            <div className="specimen">
              <div className="act-head">
                <span className="label">
                  <Ed x="Act II · settled (recorded)" p="Act II · the coin drops (recorded)" />
                </span>
                <span className={`mono ${statusClass(sample.settled.status)}`}>
                  {sample.settled.status}
                </span>
              </div>
              <pre>
                {`payer: ${sample.settled.payer}\n` +
                  Object.entries(sample.settled.headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join("\n") +
                  (sample.settled.body_note ? `\n\n${sample.settled.body_note}` : "")}
              </pre>
            </div>
          </div>
        )}

        {result && (
          <div className="console-out">
            <div className="specimen">
              <div className="act-head">
                <span className="label">
                  <Ed x="Act I · challenge" p="Act I · the turnstile asks" />
                </span>
                <span className={`mono ${statusClass(result.act1.status)}`}>
                  {result.act1.status} {result.act1.status === 402 ? "Payment Required" : ""}
                </span>
              </div>
              <pre>
                {Object.entries(result.act1.headers)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join("\n") || "(no challenge headers)"}
                {result.act1.paymentRequirements
                  ? `\n\nPaymentRequirements:\n${JSON.stringify(result.act1.paymentRequirements, null, 2)}`
                  : ""}
              </pre>
            </div>

            <div className="specimen">
              <div className="act-head">
                <span className="label">
                  {result.paid ? (
                    <Ed x="Act II · settled" p="Act II · the coin drops" />
                  ) : (
                    <Ed x="Act II · rejected" p="Act II · refused" />
                  )}
                </span>
                <span className={`mono ${statusClass(result.act2.status)}`}>{result.act2.status}</span>
              </div>
              {result.act2.paymentResponse && (
                <div className="mono muted" style={{ fontSize: 11, marginBottom: 6 }}>
                  PAYMENT-RESPONSE: {result.act2.paymentResponse}
                </div>
              )}
              {(() => {
                const { text, truncated } = pretty(result.act2.body);
                return (
                  <>
                    <pre>{expanded ? (typeof result.act2.body === "string" ? result.act2.body : JSON.stringify(result.act2.body, null, 2)) : text}</pre>
                    {truncated && (
                      <button className="mini-btn" onClick={() => setExpanded((x) => !x)}>
                        {expanded ? "collapse" : "expand"}
                      </button>
                    )}
                  </>
                );
              })()}
            </div>

            {mode === "circle" && !result.paid && (
              <div className="specimen">
                <div className="act-head">
                  <span className="label">
                    <Ed x="Act II · real Circle settlement" p="Act II · real money moves (Circle)" />
                  </span>
                  {buyerReady?.buyer_ready ? (
                    <button className="btn" onClick={settleReal} disabled={liveBusy}>
                      {liveBusy ? "signing + settling…" : "Settle for real →"}
                    </button>
                  ) : (
                    <span className="chip chip-gold">funded buyer required</span>
                  )}
                </div>
                {buyerReady?.buyer_ready ? (
                  liveOut ? (
                    liveOut.status === 200 ? (
                      <pre>
                        {`✓ settled ${liveOut.price_usdc} USDC\nscheme: exact · GatewayWalletBatched\n${refKind(liveOut.tx_ref)}: ${liveOut.tx_ref}\nnetwork: ${liveOut.network}`}
                      </pre>
                    ) : (
                      <pre className="vermilion">{`✗ ${liveOut.error ?? `status ${liveOut.status}`}`}</pre>
                    )
                  ) : liveErr ? (
                    <pre className="vermilion">{liveErr}</pre>
                  ) : (
                    <div className="lab-note" style={{ marginTop: 4 }}>
                      <Ed
                        x={
                          <>
                            The mock header fails closed on the real gate.{" "}
                            <b>Settle for real</b> signs an EIP-3009 authorization and settles
                            through Circle Gateway.
                          </>
                        }
                        p={
                          <>
                            Pretend money is refused on the real paywall.{" "}
                            <b>Settle for real</b> signs a digital check and pays through Circle.
                          </>
                        }
                      />
                    </div>
                  )
                ) : (
                  <div className="lab-note" style={{ marginTop: 4 }}>
                    {/* A dead button explains itself in words, not in the name
                        of a variable the reader cannot set. The console still
                        works — only the REAL settlement is closed here — and
                        saying that is more useful than naming the key. */}
                    <Ed
                      x="This deployment carries no funded buyer, so real settlement is closed. The console still runs every query against the live gate; only the paying half is unavailable here."
                      p="This copy of the site has no shopper with money, so it cannot pay for real; the rest of the console still works as a practice run."
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
