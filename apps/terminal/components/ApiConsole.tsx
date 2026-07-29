"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useBuyerReady, useX402Info } from "@/lib/useLive";
import { refKind } from "@/lib/chain";
import { INDICES, PRICE_FALLBACK_USDC, isIndexId } from "@/lib/indices";
import type { ConsoleResult, ExchangeSample, LiveBuyResponse, LiveBuyResult } from "@/lib/types";

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
}: {
  live: boolean;
  externalPath?: string | null;
  onRevenue: () => void;
  /** recorded two-act exchange from the bundle — shown while the gate is offline */
  sample?: ExchangeSample | null;
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
    <section className="section">
      <div className="section-head">
        <span className="label">The wire — query the index</span>
        {mode && (
          <span className={`gate-badge ${mode === "dev" ? "gold" : "green"}`}>
            {mode === "dev" ? "◆ DEV GATE" : "◆ CIRCLE GATEWAY"}
          </span>
        )}
      </div>

      <div className="console">
        <div className="console-controls">
          <div className="segmented">
            {ENDPOINTS.map((e) => (
              <button key={e.kind} className={e.kind === kind ? "on" : ""} onClick={() => setKind(e.kind)}>
                {e.label}
              </button>
            ))}
          </div>
          {current.parameterized && (
            <div className="segmented">
              {INDICES.map((i) => (
                <button key={i} className={i === index ? "on" : ""} onClick={() => setIndex(i)}>
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

        <div className="console-actions">
          <button className="btn" onClick={query} disabled={!gateLive || busy}>
            {busy ? "Paying…" : `Pay $${info?.data?.price_usdc ?? PRICE_FALLBACK_USDC} & query`}
          </button>
          {agentAllowed && (
            <label className="agent-toggle">
              <input type="checkbox" checked={agentOn} onChange={(e) => setAgentOn(e.target.checked)} />
              <span className="label">Demo agent — 1 query / 4s</span>
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
            "The gate is offline — below is a RECORDED exchange from the archived edition."
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
                <span className="label">Act I — challenge (recorded)</span>
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
                <span className="label">Act II — settled (recorded)</span>
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
                <span className="label">Act I — challenge</span>
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
                <span className="label">Act II — {result.paid ? "settled" : "rejected"}</span>
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
                  <span className="label">Act II — real Circle settlement</span>
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
                      The mock header fails closed on the real gate — click <b>Settle for real</b> to
                      sign an EIP-3009 authorization and settle through Circle Gateway. Draws from the
                      buyer&apos;s Gateway deposit; the receipt is a real gateway-ref.
                    </div>
                  )
                ) : (
                  <div className="lab-note" style={{ marginTop: 4 }}>
                    The Circle gate fails closed: real settlement needs a funded buyer. Set{" "}
                    <span className="mono">ACR_BUYER_PRIVATE_KEY</span> (a funded EOA with an open
                    Gateway deposit) to enable one-click settlement here, or run the mock gate with{" "}
                    <span className="mono">ACR_X402_MODE=dev make api</span>.
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
