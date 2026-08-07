"use client";

import { Fragment, useState } from "react";
import { AddressChip } from "@/components/chain/AddressChip";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { chainFacts } from "@/lib/chain";
import { useCatalog, useTerminal } from "@/lib/useLive";
import { useEdition } from "@/lib/useEdition";
import { fmtInt, money } from "@/lib/format";
import { INDICES } from "@/lib/indices";
import type { Envelope, TerminalData } from "@/lib/types";

export function SellersView({ initial }: { initial: Envelope<TerminalData> }) {
  const env = useTerminal(initial);
  const catalog = useCatalog();
  const [selected, setSelected] = useState<string>(INDICES[0]);
  /* The attestation column was a verdict nobody could act on. Filtering to it
     is the one interaction that makes the registry's argument playable: the
     claim is that filing a record earns placement, and this is the control that
     lets a reader check whether the top of the table is in fact the filed set. */
  const [attestedOnly, setAttestedOnly] = useState(false);
  /* Which row is showing its arithmetic. One at a time: the table is the
     comparison, and several open rows push the rest off the fold. */
  const [expanded, setExpanded] = useState<string | null>(null);
  const sellers = env.data.sellers?.[selected];
  const shown = attestedOnly ? sellers?.filter((s) => s.attested) : sellers;

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
          x="Sellers who attest their metadata are priced like-for-like. Attestation earns placement."
          p="Sellers who file a signed record of what they sell get compared fairly. Filing earns a place in this paper."
        />
      </div>

      <section className="section">
        <div className="panel panel-pad">
          <div className="section-head" style={{ marginTop: 0 }}>
            <span className="label">
              <Ed x="Registry · on-chain attestations" p="The register · sworn seller records" />
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
                  {att.services?.length ? att.services.join(" · ") : "none listed"}
                </div>
                <div className="counter-label label">Services covered</div>
              </div>
              {att.latency_slo_ms && (att.latency_slo_ms.min != null || att.latency_slo_ms.max != null) ? (
                <div>
                  <div className="counter-value" style={{ fontSize: 20 }}>
                    {att.latency_slo_ms.min ?? "n/a"}–{att.latency_slo_ms.max ?? "n/a"} ms
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
                  <span className="mono">AttestationRegistry</span>. It fills in once the API
                  warms.
                </>
              }
              p={
                <>
                  This card fills in once our server wakes. Each entry is a seller’s{" "}
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
            <Ed x={<>Seller reliability · {selected}</>} p={<>Seller trust ranking · {selected}</>} />
            {simTape ? (
              <span
                className="muted"
                title={
                  plain
                    ? "this feed is the calibrated simulator. The card above counts the real blockchain records"
                    : "the tape is the calibrated simulator. The card above counts the real on-chain records"
                }
              >
                {" "}
                <Ed
                  x={<>· sim tape{att ? ` · ${fmtInt(att.sellers_attested)} real attestations on-chain` : ""}</>}
                  p={<>· simulated feed{att ? ` · ${fmtInt(att.sellers_attested)} real sworn records on the blockchain` : ""}</>}
                />
              </span>
            ) : null}
          </span>
          {/* Two controls, and `type="button"` on both: the default is submit,
              and `aria-pressed` is what tells a screen reader which one is on —
              the /attack presets already do this and these did not. */}
          <div className="btn-row">
            <div className="segmented" role="group" aria-label="attestation filter">
              <button
                type="button"
                className={attestedOnly ? "" : "on"}
                aria-pressed={!attestedOnly}
                onClick={() => setAttestedOnly(false)}
              >
                <Ed x="all" p="everyone" />
              </button>
              <button
                type="button"
                className={attestedOnly ? "on" : ""}
                aria-pressed={attestedOnly}
                onClick={() => setAttestedOnly(true)}
              >
                <Ed x="attested" p="filed a record" />
              </button>
            </div>
            <div className="segmented" role="group" aria-label="index">
              {INDICES.map((iid) => (
                <button
                  key={iid}
                  type="button"
                  className={iid === selected ? "on" : ""}
                  aria-pressed={iid === selected}
                  onClick={() => setSelected(iid)}
                >
                  {iid.replace("ACR-", "")}
                </button>
              ))}
            </div>
          </div>
        </div>

        {shown?.length ? (
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
                {shown.map((s) => {
                  const open = expanded === s.seller;
                  /* The score's two halves are already on every row and the
                     page states the formula in prose below. Showing the
                     arithmetic per seller is what turns "0.842" from a verdict
                     into a claim a reader can check. Both halves are ½-weighted
                     (see the footnote), so this is the whole derivation. */
                  const cleanHalf = 0.5 * s.clean_share;
                  const attHalf = s.attested ? 0.5 : 0;
                  return (
                <Fragment key={s.seller}>
                <tr
                  className="row-link"
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  aria-label={`show how ${s.seller.slice(0, 10)} scored ${s.score.toFixed(3)}`}
                  title={open ? "hide the arithmetic" : "show how this score was reached"}
                  onClick={() => setExpanded(open ? null : s.seller)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setExpanded(open ? null : s.seller);
                    }
                  }}
                >
                    {/* Was dead `shortAddr` text on a page whose whole claim is
                        "check it yourself". AddressChip tiers honestly: a real
                        hex address links out to the explorer, a simulated
                        seller id gets the dashed ring and no link, so the sim
                        tape cannot borrow the credibility of a real one. */}
                    <td>
                      <AddressChip address={s.seller} explorer={facts.explorer} />
                    </td>
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
                                ? "sworn within the simulated feed. Real blockchain records are counted in the register card above"
                                : "attested within the simulated tape. Real on-chain records are counted in the registry card above"
                              : plain
                                ? "a verifiably signed record read from the public register"
                                : "EIP-712 record read from the on-chain AttestationRegistry"
                          }
                        >
                          {/* The badge is the claim; the registry is where the
                              claim is checkable. There is no per-seller tx in
                              the payload, so the contract is the honest target
                              rather than a link that implies more than we hold. */}
                          {facts.registry && facts.explorer && !simTape ? (
                            <a
                              className="chip chip-teal"
                              href={`${facts.explorer}/address/${facts.registry}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Ed x="EIP-712 ✓" p="signed ✓" />
                            </a>
                          ) : (
                            <>
                              <Ed x="EIP-712 ✓" p="signed ✓" />
                              {simTape ? <span className="muted"> sim</span> : null}
                            </>
                          )}
                        </span>
                      ) : (
                        <span className="muted">
                          <Ed x="unattested" p="no record filed" />
                        </span>
                      )}
                    </td>
                    <td>{money(s.volume_usdc, 0)}</td>
                  </tr>
                  {open ? (
                    <tr>
                      <td colSpan={5} className="wrap">
                        <span className="mono" style={{ fontSize: 12.5 }}>
                          ½ · {(100 * s.clean_share).toFixed(0)}% = {cleanHalf.toFixed(3)}
                          {"  ·  "}½ · {s.attested ? "1" : "0"} = {attHalf.toFixed(3)}
                          {"  ·  "}
                          <b className="gold">{s.score.toFixed(3)}</b>
                        </span>{" "}
                        <span className="muted" style={{ fontSize: 12.5 }}>
                          <Ed
                            x="clean-volume share and the signed record, half each."
                            p="honest volume and a filed record, half each."
                          />
                        </span>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="awaiting">
            {/* A filter that empties the table must say it was the filter. The
                cold-press copy below would otherwise blame the server for a
                state the reader just created with a click. */}
            {attestedOnly && sellers?.length ? (
              <Ed
                x="No attested sellers on this index yet. Switch to all to see the rest."
                p="Nobody has filed a record on this one yet. Switch to everyone to see the rest."
              />
            ) : env.live ? (
              "Awaiting seller verdicts"
            ) : (
              <Ed
                x="The registry opens when the press answers. It wakes on first visit (~60s) and this page retries by itself."
                p="This list needs our server, which naps between visits. It is waking now, and this page keeps trying on its own."
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
