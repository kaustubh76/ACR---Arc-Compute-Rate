"use client";

import { Fragment, useCallback, useState } from "react";
import { AddressChip } from "@/components/chain/AddressChip";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { chainFacts } from "@/lib/chain";
import { useCatalog, useTerminal } from "@/lib/useLive";
import { useEdition } from "@/lib/useEdition";
import { fmtInt, money } from "@/lib/format";
import { INDICES } from "@/lib/indices";
import type {
  CatalogAttestationRow,
  Envelope,
  RegistryDirectRead,
  RegistryOnchainRecord,
  TerminalData,
} from "@/lib/types";

/** The records behind the counter above.
 *
 *  The press reads these on every catalog refresh and used to keep only their
 *  count, so this page printed a number over sixty simulated rows that are not
 *  those sellers, with nothing to show instead. These are real 42-char hex, so
 *  AddressChip links every one to the explorer, which is the whole argument: a
 *  reader can leave the page and come back convinced.
 *
 *  Local to this file because lib/coverage.test.ts ledgers every .tsx under
 *  app/ and components/ in both directions, so extracting it would need an entry. */
function RegistryRows({
  rows,
  explorer,
  chain,
}: {
  rows: CatalogAttestationRow[] | undefined;
  explorer?: string;
  /** The chain's own records, keyed lowercase, once the reader has pressed
   *  "read it from the chain". `null` before that, and that is the design:
   *  these rows carry no caret and no click until there is something behind
   *  them, so a caret on this page always means real extra evidence. */
  chain: Map<string, RegistryOnchainRecord> | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="label" style={{ marginTop: 22, marginBottom: 8 }}>
        <Ed x="the records, in full" p="the sworn records, in full" />
      </div>
      <div className="table-scroll">
        <table className="sheet">
          <thead>
            <tr>
              <th>
                <Ed x="seller" p="who filed" />
              </th>
              <th>
                <Ed x="service" p="what they sell" />
              </th>
              <th>
                <Ed x="class" p="quality tier" />
              </th>
              <th>
                <Ed x="latency" p="promised speed" />
              </th>
              <th>
                <Ed x="schema" p="format" />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows?.length ? (
              rows.map((r) => {
                const rec = chain?.get(r.seller.toLowerCase()) ?? null;
                // Read but absent: the press lists a seller the contract did
                // not return. A free disagreement detector, and it must look
                // like a problem rather than like a row with nothing to open.
                const missing = chain !== null && rec === null;
                const isOpen = open === r.seller;
                const toggle = () => setOpen(isOpen ? null : r.seller);
                return (
                  <Fragment key={r.seller}>
                    <tr
                      className={rec ? "row-link" : ""}
                      role={rec ? "button" : undefined}
                      tabIndex={rec ? 0 : undefined}
                      aria-expanded={rec ? isOpen : undefined}
                      aria-label={
                        rec ? `show what the chain returned for ${r.seller.slice(0, 10)}` : undefined
                      }
                      onClick={
                        rec
                          ? (e) => {
                              // The first cell holds an explorer link and a
                              // copy button; without this guard, opening the
                              // explorer also toggles the row.
                              if ((e.target as HTMLElement).closest("a, .addr-copy")) return;
                              toggle();
                            }
                          : undefined
                      }
                      onKeyDown={
                        rec
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                toggle();
                              }
                            }
                          : undefined
                      }
                    >
                      <td>
                        {rec ? (
                          <span className="muted" aria-hidden>
                            {isOpen ? "▾ " : "▸ "}
                          </span>
                        ) : missing ? (
                          <span className="vermilion" aria-hidden>
                            {"! "}
                          </span>
                        ) : null}
                        <AddressChip address={r.seller} explorer={explorer} />
                      </td>
                      <td>{r.service}</td>
                      <td>{r.model_class}</td>
                      <td className="mono">{fmtInt(r.latency_slo_ms)} ms</td>
                      <td className="mono">{r.schema_id}</td>
                    </tr>
                    {isOpen && rec ? (
                      <tr>
                        <td colSpan={5} className="wrap">
                          {/* The raw return, not our summary of it. This is the
                              only place on the page showing values the press
                              payload does not carry. */}
                          <span className="mono" style={{ fontSize: 12.5 }}>
                            service={rec.service_code} ({rec.service})
                            {"  ·  "}modelClass={rec.class_code} ({rec.model_class})
                            {"  ·  "}latencySloMs={fmtInt(rec.latency_slo_ms)}
                            <br />
                            schemaId={rec.schema_id_hex}
                            <br />
                            timestamp={fmtInt(rec.attested_at)}
                          </span>
                        </td>
                      </tr>
                    ) : null}
                    {missing ? (
                      <tr>
                        <td colSpan={5} className="wrap vermilion" style={{ fontSize: 12.5 }}>
                          <Ed
                            x="The press lists this seller and the contract did not return it. Trust the chain, not this page."
                            p="Our server lists this seller and the blockchain did not. Believe the blockchain."
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            ) : (
              <tr>
                {/* Two empties, two sentences. `undefined` means the archived
                    bundle predates this field; `[]` means the chain was read and
                    holds nothing. Opposite conclusions, so the press keeps them
                    apart (optional key vs empty array) and so does this row. */}
                <td colSpan={5} className="wrap muted">
                  {rows === undefined ? (
                    <Ed
                      x="This archived copy carries the count but not the rows: it was taken before the press served them. The live page lists every one."
                      p="This saved copy has the number but not the names, because it was made before we served them."
                    />
                  ) : (
                    <Ed
                      x="The registry is connected and holds no records yet, which is what the counter above says."
                      p="The register is working and holds nothing yet, which is what the number above says."
                    />
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function SellersView({ initial }: { initial: Envelope<TerminalData> }) {
  const env = useTerminal(initial);
  const catalog = useCatalog();
  const [selected, setSelected] = useState<string>(INDICES[0]);
  /* Was `attestedOnly`, filtering on `s.attested` — which the published tape
     sets TRUE on every row (the simulator attests every honest seller it
     generates, and this tape carries no adversary). So the control returned the
     identical table, and a reader testing "does filing earn placement" was
     answered "all sixty filed" — the page's central falsehood wearing a button.

     It now filters on membership of the REAL registry: the addresses the card
     above lists. On this deployment that returns nothing and the empty state
     says why, so the argument is finally playable and pointed at the true
     claim. On a seeded Arc tape (`make seed-sellers` + ACR_TAPE_SOURCE=arc) the
     same control starts returning those sellers with no code change. */
  const [registryOnly, setRegistryOnly] = useState(false);
  /* Which row is showing its arithmetic. One at a time: the table is the
     comparison, and several open rows push the rest off the fold. */
  const [expanded, setExpanded] = useState<string | null>(null);
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

  // null (not empty) when the rows are unknown — an archived bundle predating
  // the field. The control hides rather than filtering on a set it cannot see.
  const onchain = att?.sellers
    ? new Set(att.sellers.map((r) => r.seller.toLowerCase()))
    : null;
  const filtering = registryOnly && onchain !== null;
  const shown = filtering
    ? sellers?.filter((s) => onchain!.has(s.seller.toLowerCase()))
    : sellers;

  /* The page's own claim is "check it yourself", and until now it offered no
     way to. Every other figure here arrives through the press, so the card's
     "4 attested" is something a reader has to take on our word. This asks Arc
     directly and shows what came back, stamped with the block it was read at.
     No other button in this app re-reads a source to prove a claim. */
  const [reading, setReading] = useState(false);
  const [chainRead, setChainRead] = useState<RegistryDirectRead | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);

  const readChain = useCallback(async () => {
    setReading(true);
    setReadErr(null);
    try {
      const res = await fetch("/api/registry", { cache: "no-store" });
      const body = (await res.json()) as RegistryDirectRead & { detail?: string };
      if (!res.ok) {
        setReadErr(String(body.detail ?? `the read failed (${res.status})`));
        setChainRead(null);
      } else {
        setChainRead(body);
      }
    } catch {
      setReadErr("could not reach the chain from here. Press again");
    } finally {
      setReading(false);
    }
  }, []);

  /* Keyed lowercase so a record can be matched to the press row beside it.
     null until a read lands, which is what gates the per-record carets: a
     caret that opens onto a restatement of the row above it is a lie about
     there being something behind it. */
  const chainBySeller =
    chainRead && new Map(chainRead.sellers.map((r) => [r.seller.toLowerCase(), r]));

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

          {/* The action the page's own thesis demands. It goes to Arc directly
              rather than through the press, so it still works when the press is
              asleep — that is the point, and why it is not gated on `att`. */}
          <div className="btn-row" style={{ marginTop: 18 }}>
            <button className="btn" onClick={readChain} disabled={reading}>
              <Ed
                x={reading ? "asking the chain…" : "read it from the chain"}
                p={reading ? "asking the blockchain…" : "check this on the blockchain"}
              />
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0", maxWidth: 68 * 9 }}>
            <Ed
              x="Everything else on this page reaches you through our press. This asks the contract itself and shows what came back, at the block it was read."
              p="Everything else here comes through our server. This asks the blockchain itself and shows you the answer."
            />
          </p>

          {readErr ? (
            <p
              className="mono vermilion"
              role="alert"
              style={{ fontSize: 12.5, margin: "10px 0 0", maxWidth: 68 * 9 }}
            >
              {readErr}
            </p>
          ) : null}

          {chainRead ? (
            <div className="panel panel-pad" style={{ marginTop: 12 }}>
              <div className="section-head" style={{ marginTop: 0 }}>
                <span className="label">
                  <Ed x="what the chain returned" p="what the blockchain said" />
                </span>
                <span className="chip chip-teal">
                  <Ed x="read just now" p="asked just now" />
                </span>
              </div>
              {/* Block height and latency are the payload, not decoration: they
                  are what distinguishes a reading from a re-render of the card
                  above. Press twice and the block should move. */}
              <table className="sheet" style={{ marginTop: 8 }}>
                <tbody>
                  <tr>
                    <td className="muted mono" style={{ width: 190 }}>
                      block
                    </td>
                    <td className="mono gold">{fmtInt(chainRead.block)}</td>
                  </tr>
                  <tr>
                    <td className="muted mono">sellerCount()</td>
                    <td className="mono">{fmtInt(chainRead.seller_count)}</td>
                  </tr>
                  <tr>
                    <td className="muted mono">chain</td>
                    <td className="mono">eip155:{chainRead.chain_id}</td>
                  </tr>
                  <tr>
                    <td className="muted mono">took</td>
                    <td className="mono">{fmtInt(chainRead.took_ms)} ms</td>
                  </tr>
                </tbody>
              </table>
              <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0", maxWidth: 68 * 9 }}>
                <Ed
                  x="Each record above is now a row you can open, showing the raw values the contract returned rather than our summary of them."
                  p="Each record above now opens, showing the exact values the blockchain gave back."
                />
              </p>
            </div>
          ) : null}

          {/* The evidence under the number. Only when the summary itself read:
              a table of nothing under a card of nothing is two apologies for
              one fact. */}
          {att ? (
            <>
              <RegistryRows
                rows={att.sellers}
                explorer={facts.explorer}
                chain={chainBySeller ?? null}
              />

              <p className="muted" style={{ fontSize: 12.5, margin: "12px 0 0", maxWidth: 68 * 9 }}>
                <Ed
                  x="The signatures verify and the chain state is real, but these keys are derived in this repo, so the seller and the operator here are the same party."
                  p="These signatures are real, but we made these sellers ourselves, so they are us."
                />
              </p>

              <details className="disclosure" style={{ marginTop: 14 }}>
                <summary>
                  <Ed x="who signed these, and how" p="who really signed these" />
                </summary>
                <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                  <Ed
                    as="p"
                    className="muted"
                    style={{ fontSize: 12.5, margin: 0, maxWidth: 68 * 9 }}
                    x="Each key is sha256 of a label in packages/acr_oracle_client/demo_sellers.py, so anyone holding this repo can reproduce all four addresses."
                    p="Each key comes from a name written in this repo, so anyone with the code can work out these addresses."
                  />
                  <Ed
                    as="p"
                    className="muted"
                    style={{ fontSize: 12.5, margin: 0, maxWidth: 68 * 9 }}
                    x="Every one of these accounts has nonce 0: none ever sent a transaction. The funded poster relayed each signed record through attestWithSig, which is what a meta-transaction is for, and is why the contract checks the signature rather than the sender."
                    p="None of them ever paid a fee, because we filed their signed forms for them, and the form is what the contract checks."
                  />
                  <Ed
                    as="p"
                    className="muted"
                    style={{ fontSize: 12.5, margin: 0, maxWidth: 68 * 9 }}
                    x="make seed-sellers with ACR_TAPE_SOURCE=arc puts these addresses into the tape, at which point the table below becomes the registry's own set. This deployment publishes the simulator instead, for the reason /developers gives."
                    p="One command would put these into the live feed, and then the list below would be them."
                  />
                </div>
              </details>

              {/* The disjointness, in the open. This used to live only in a
                  title= tooltip, which is invisible on a phone, in a
                  screenshot, and in a demo video. */}
              <p className="muted" style={{ fontSize: 13, margin: "14px 0 0", maxWidth: 68 * 9 }}>
                <Ed
                  x="Those addresses are the entire registry, and not one of them appears in the table below."
                  p="Those names are everything the register holds, and none of them is in the list below."
                />{" "}
                <Ed
                  x="The table below is the calibrated simulator's tape: its seller ids are generated, and so is every record they carry."
                  p="The list below comes from our simulator, which invented those sellers and their records together."
                />
              </p>
            </>
          ) : null}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <span className="label">
            <Ed x={<>Seller reliability · {selected}</>} p={<>Seller trust ranking · {selected}</>} />
            {simTape ? (
              <span className="muted">
                {" "}
                <Ed
                  x={<>· sim tape{att ? ` · ${fmtInt(att.sellers_attested)} on-chain records, listed above` : ""}</>}
                  p={<>· simulated feed{att ? ` · ${fmtInt(att.sellers_attested)} real sworn records, listed above` : ""}</>}
                />
              </span>
            ) : null}
          </span>
          {/* Two controls, and `type="button"` on both: the default is submit,
              and `aria-pressed` is what tells a screen reader which one is on —
              the /attack presets already do this and these did not. */}
          <div className="btn-row">
            {onchain !== null ? (
              <div className="segmented" role="group" aria-label="registry membership filter">
                <button
                  type="button"
                  className={registryOnly ? "" : "on"}
                  aria-pressed={!registryOnly}
                  onClick={() => setRegistryOnly(false)}
                >
                  <Ed x="all" p="everyone" />
                </button>
                <button
                  type="button"
                  className={registryOnly ? "on" : ""}
                  aria-pressed={registryOnly}
                  onClick={() => setRegistryOnly(true)}
                >
                  <Ed x="in the registry" p="in the register" />
                </button>
              </div>
            ) : null}
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
                    {simTape ? (
                      <Ed x="Record · simulator" p="Record · simulated" />
                    ) : (
                      <Ed x="Attestation" p="Sworn record" />
                    )}
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
                  onClick={(e) => {
                    /* The first cell holds an explorer link and a copy button.
                       Without this guard, "open in the explorer" ALSO toggled
                       the row and copying an address opened a panel nobody
                       asked for. Adding the caret below makes the row visibly
                       clickable, which makes that collision far easier to hit. */
                    if ((e.target as HTMLElement).closest("a, .addr-copy")) return;
                    setExpanded(open ? null : s.seller);
                  }}
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
                      {/* `.row-link` gives only `cursor: pointer`, and the hover
                          tint at globals.css:1054 is on EVERY tbody tr — so a
                          clickable row was pixel-identical to a static one, and
                          invisible entirely to a touch user or a screenshot.
                          The caret is the affordance the CSS cannot be; it is
                          the same glyph pair WebhookActivity and
                          details.disclosure already use. aria-hidden because
                          aria-expanded on the row already carries the state. */}
                      <span className="muted" aria-hidden>
                        {open ? "▾ " : "▸ "}
                      </span>
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
                        simTape ? (
                          /* Not green, no tick, no link. The flag is true and it
                             is the SIMULATOR's: a green EIP-712 tick is on-chain
                             vocabulary this row has not earned, and a reader who
                             reads it as the registry card above reads it exactly
                             backwards. `chip-sim` is the tier the house already
                             uses for simulated things. The title= tooltips are
                             gone with it: they were where this hid. */
                          <span className="chip chip-sim">
                            <Ed x="sim record" p="simulated" />
                          </span>
                        ) : (
                          <span className="green">
                            {/* The badge is the claim; the registry is where the
                                claim is checkable. There is no per-seller tx in
                                the payload, so the contract is the honest target
                                rather than a link implying more than we hold. */}
                            {facts.registry && facts.explorer ? (
                              <a
                                className="chip chip-teal"
                                href={`${facts.explorer}/address/${facts.registry}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <Ed x="EIP-712 ✓" p="signed ✓" />
                              </a>
                            ) : (
                              <Ed x="EIP-712 ✓" p="signed ✓" />
                            )}
                          </span>
                        )
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
                          {simTape ? (
                            <Ed
                              x="clean-volume share and the simulator's own record, half each."
                              p="honest volume and the record our simulator made, half each."
                            />
                          ) : (
                            <Ed
                              x="clean-volume share and the signed record, half each."
                              p="honest volume and a filed record, half each."
                            />
                          )}
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
            {filtering && sellers?.length ? (
              <Ed
                x="No seller on this tape is one of the addresses in the registry above. That is the honest state of this deployment, not an empty feed."
                p="None of these sellers is one of the names in the register above, and that is the true state here, not a broken page."
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

        {simTape ? (
          <Ed
            as="p"
            className="muted"
            style={{ fontSize: 12.5, marginTop: 10, maxWidth: 68 * 9 }}
            x="The simulator files a record for every honest seller it generates, so that column reads the same on every row and ranks nobody."
            p="Our simulator gives every honest seller a record, so that column says the same thing on every row."
          />
        ) : null}

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
