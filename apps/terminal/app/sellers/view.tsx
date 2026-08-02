"use client";

import { useState } from "react";
import { AddressChip } from "@/components/chain/AddressChip";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { chainFacts } from "@/lib/chain";
import { useCatalog, useTerminal } from "@/lib/useLive";
import { useEdition } from "@/lib/useEdition";
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
  // On the sim tape most sellers carry SIMULATED attestations (part of the
  // calibrated market) — only the registry card above counts real on-chain
  // records. Label the table honestly so the two numbers can't be confused.
  const simTape = facts.tapeSource === "sim";
  const plain = useEdition() === "plain";

  return (
    <>
      <div className="standfirst-block" style={{ marginTop: 40 }}>
        <Ed
          as="p"
          className="standfirst"
          style={{ margin: 0 }}
          x="Sellers who attest their metadata are priced like-for-like — attestation earns placement."
          p="Sellers who file a signed record of what they sell get compared fairly — filing earns a place in this paper."
        />
      </div>

      <section className="section">
        <div className="panel panel-pad">
          <div className="section-head" style={{ marginTop: 0 }}>
            <span className="label">
              <Ed x="Registry — on-chain attestations" p="The register — sworn seller records" />
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
                <div className="counter-label label">
                  <Ed x="Sellers attested (on-chain)" p="Sellers with sworn records" />
                </div>
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
                  <div className="counter-label label">
                    <Ed x="Latency SLO range" p="Promised answer speed" />
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <Ed
              as="p"
              className="muted"
              style={{ fontSize: 13, margin: "12px 0 0" }}
              x={
                <>
                  The attestation summary reads live from the on-chain{" "}
                  <span className="mono">AttestationRegistry</span> — it fills in once the API
                  warms.
                </>
              }
              p={
                <>
                  This card fills in once our server wakes — each entry is a seller’s{" "}
                  <Term k="eip712">verifiably signed</Term> statement of what they offer.
                </>
              }
            />
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <span className="label">
            <Ed x={<>Seller reliability — {selected}</>} p={<>Seller trust ranking — {selected}</>} />
            {simTape ? (
              <span
                className="muted"
                title={
                  plain
                    ? "this feed is the calibrated simulator — the card above counts the real blockchain records"
                    : "the tape is the calibrated simulator — the card above counts the real on-chain records"
                }
              >
                {" "}
                <Ed
                  x={<>· sim tape{att ? ` — ${fmtInt(att.sellers_attested)} real attestations on-chain` : ""}</>}
                  p={<>· simulated feed{att ? ` — ${fmtInt(att.sellers_attested)} real sworn records on the blockchain` : ""}</>}
                />
              </span>
            ) : null}
          </span>
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
                  <th>
                    <Ed x="Clean share" p="Honest volume" />
                  </th>
                  <th>
                    <Ed x="Attestation" p="Sworn record" />
                  </th>
                  <th>
                    <Ed x="Volume (USDC)" p="Volume (dollars)" />
                  </th>
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
                        <span
                          className="green"
                          title={
                            simTape
                              ? plain
                                ? "sworn within the simulated feed — real blockchain records are counted in the register card above"
                                : "attested within the simulated tape — real on-chain records are counted in the registry card above"
                              : plain
                                ? "a verifiably signed record read from the public register"
                                : "EIP-712 record read from the on-chain AttestationRegistry"
                          }
                        >
                          <Ed x="EIP-712 ✓" p="signed ✓" />
                          {simTape ? <span className="muted"> sim</span> : null}
                        </span>
                      ) : (
                        <span className="muted">
                          <Ed x="unattested" p="no record filed" />
                        </span>
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
            {env.live ? (
              "Awaiting seller verdicts —"
            ) : (
              <Ed
                x="The registry requires the live index API — run `make api`."
                p="The register needs our live server — start it with `make api`."
              />
            )}
          </div>
        )}

        <Ed
          as="p"
          className="muted"
          style={{ fontSize: 13, marginTop: 16, maxWidth: 68 * 9 }}
          x={
            <>
              Score = ½ · clean-volume share + ½ · attestation, over the latest window
              {fmtInt(sellers?.length ?? 0) !== "0" ? <> · top {sellers?.length} by score</> : null}.
            </>
          }
          p={
            <>
              Score = half “volume that survived the fake filter” plus half “filed a{" "}
              <Term k="attestation">sworn record</Term>”, over the latest window
              {fmtInt(sellers?.length ?? 0) !== "0" ? <> · top {sellers?.length} by score</> : null}.
            </>
          }
        />
      </section>
    </>
  );
}
