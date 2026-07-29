"use client";

import { useState } from "react";
import { AddressChip } from "@/components/chain/AddressChip";
import { chainFacts } from "@/lib/chain";
import { useCatalog, useTerminal } from "@/lib/useLive";
import { fmtInt, money, shortAddr } from "@/lib/format";
import { INDICES } from "@/lib/indices";
import type { Envelope, TerminalData } from "@/lib/types";

export function SellersView({ initial }: { initial: Envelope<TerminalData> }) {
  const env = useTerminal(initial);
  const catalog = useCatalog();
  const [selected, setSelected] = useState<string>(INDICES[0]);
  const sellers = env.data.sellers?.[selected];

  // The REAL on-chain attestation summary, read from AttestationRegistry and
  // served by /marketplace/catalog. Null during a cold-start warm — the registry
  // address (always real) still anchors the card.
  const att = catalog?.data?.provider?.attestation ?? null;
  const attLive = catalog?.live === true && att != null;
  const facts = chainFacts(env.data.chain);

  return (
    <>
      <div className="standfirst-block" style={{ marginTop: 40 }}>
        <p className="standfirst" style={{ margin: 0 }}>
          Sellers who attest their metadata are priced fairly by the hedonic adjustment —
          attestation earns placement.
        </p>
      </div>

      <section className="section">
        <div className="panel panel-pad">
          <div className="section-head" style={{ marginTop: 0 }}>
            <span className="label">
              Registry — on-chain attestations
              {attLive ? <span className="green"> · live</span> : null}
            </span>
            <span className={`chip ${attLive ? "chip-teal" : "chip-sim"}`}>
              <i className={`dot${attLive ? " breathe" : ""}`} />
              AttestationRegistry
            </span>
          </div>

          <div className="provenance-row" style={{ borderBottom: "1px solid var(--hairline)" }}>
            <span className="label">Registry</span>
            <span className="val">
              {facts.registry ? (
                <AddressChip address={facts.registry} explorer={facts.explorer} />
              ) : (
                <span className="muted">not deployed</span>
              )}
            </span>
          </div>

          {att ? (
            <div className="lab-counters" style={{ marginTop: 18 }}>
              <div>
                <div className="counter-value gold" style={{ fontSize: 30 }}>
                  {fmtInt(att.sellers_attested)}
                </div>
                <div className="counter-label label">Sellers attested (on-chain)</div>
              </div>
              <div>
                <div className="counter-value" style={{ fontSize: 20 }}>
                  {att.services?.length ? att.services.join(" · ") : "—"}
                </div>
                <div className="counter-label label">Services covered</div>
              </div>
              {att.latency_slo_ms && (att.latency_slo_ms.min != null || att.latency_slo_ms.max != null) ? (
                <div>
                  <div className="counter-value" style={{ fontSize: 20 }}>
                    {att.latency_slo_ms.min ?? "—"}–{att.latency_slo_ms.max ?? "—"} ms
                  </div>
                  <div className="counter-label label">Latency SLO range</div>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13, margin: "12px 0 0" }}>
              The attestation summary reads live from the on-chain{" "}
              <span className="mono">AttestationRegistry</span> — it fills in once the API warms.
              EIP-712 seller records (<span className="mono">attestWithSig</span>) prove metadata the
              hedonic stage constant-quality-adjusts against.
            </p>
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <span className="label">Seller reliability — {selected}</span>
          <div className="segmented">
            {INDICES.map((iid) => (
              <button
                key={iid}
                className={iid === selected ? "on" : ""}
                onClick={() => setSelected(iid)}
              >
                {iid.replace("ACR-", "")}
              </button>
            ))}
          </div>
        </div>

        {sellers?.length ? (
          <div className="table-scroll">
            <table className="sheet">
              <thead>
                <tr>
                  <th>Seller</th>
                  <th>Score</th>
                  <th>Clean share</th>
                  <th>Attestation</th>
                  <th>Volume (USDC)</th>
                </tr>
              </thead>
              <tbody>
                {sellers.map((s) => (
                  <tr key={s.seller}>
                    <td className="mono">{shortAddr(s.seller)}</td>
                    <td style={{ fontWeight: 600 }}>{s.score.toFixed(3)}</td>
                    <td>
                      <span className="share-bar" style={{ marginRight: 10 }}>
                        <i style={{ width: `${100 * s.clean_share}%` }} />
                      </span>
                      {(100 * s.clean_share).toFixed(0)}%
                    </td>
                    <td>
                      {s.attested ? (
                        <span className="green">EIP-712 ✓</span>
                      ) : (
                        <span className="muted">unattested</span>
                      )}
                    </td>
                    <td>{money(s.volume_usdc, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="awaiting">
            {env.live
              ? "Awaiting seller verdicts —"
              : "The registry requires the live index API — run `make api`."}
          </div>
        )}

        <p className="muted" style={{ fontSize: 13, marginTop: 16, maxWidth: 68 * 9 }}>
          Score = ½ · clean-volume share + ½ · attestation, over the cleaning stack’s verdicts for
          the latest window. Attestations are EIP-712 records in{" "}
          <span className="mono">AttestationRegistry</span>
          {fmtInt(sellers?.length ?? 0) !== "0" ? <> · top {sellers?.length} by score</> : null}.
        </p>
      </section>
    </>
  );
}
