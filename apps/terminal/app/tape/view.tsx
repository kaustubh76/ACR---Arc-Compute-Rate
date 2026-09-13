"use client";

import { AddressChip } from "@/components/chain/AddressChip";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { ageWordsAt, fmtInt, money } from "@/lib/format";
import {
  MIN_RATED_N,
  bp,
  bpFromWeighted,
  bucketBars,
  bucketTotal,
  byWorstFirst,
  followedReroute,
  humanCell,
  usdc6,
} from "@/lib/tape";
import type { SellerRating, TapeRecentRow, TapeSeller, TcaCard } from "@/lib/tape";
import { useTape } from "@/lib/useLive";
import { useNow } from "@/lib/useNow";
import { useEffect, useState } from "react";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Grade any agent, not just the one the page picked.
 *
 *  The whole read path for this already existed — `useTape(payer)` builds
 *  `?payer=`, the route prefers an explicit param over the busiest payer on the
 *  tape, and `/tca/{payer}` is public. What was missing was somewhere to type an
 *  address, so the page could only ever show you someone else's fills.
 *
 *  Validated here rather than upstream: a typo is the common case, and a
 *  malformed address should cost nothing and reach nothing. The URL carries the
 *  answer so a result can be linked to rather than re-typed. */
function PayerField({
  value,
  onPick,
  onReset,
}: {
  value: string | null;
  onPick: (addr: string) => void;
  onReset: () => void;
}) {
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);

  return (
    <form
      style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
      onSubmit={(e) => {
        e.preventDefault();
        const addr = text.trim();
        if (!ADDRESS.test(addr)) {
          setBad(true);
          return;
        }
        setBad(false);
        onPick(addr.toLowerCase());
      }}
    >
      <input
        className="mono"
        aria-label="agent address"
        placeholder="0x…"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (bad) setBad(false);
        }}
        style={{
          font: "inherit",
          fontSize: 12,
          padding: "4px 8px",
          width: 260,
          border: `1px solid ${bad ? "var(--breach)" : "var(--rule)"}`,
          background: "transparent",
          color: "inherit",
        }}
      />
      <button type="submit" className="chip" style={{ cursor: "pointer" }}>
        <Ed x="Grade it" p="Check it" />
      </button>
      {value ? (
        <button
          type="button"
          className="chip muted"
          style={{ cursor: "pointer" }}
          onClick={() => {
            setText("");
            setBad(false);
            onReset();
          }}
        >
          <Ed x="Busiest" p="Back to the busiest" />
        </button>
      ) : null}
      {bad ? (
        <span className="muted" style={{ fontSize: 12, color: "var(--breach)" }}>
          <Ed
            x="Not an address: 0x and 40 hex characters."
            p="That is not an address. It needs 0x and 40 characters."
          />
        </span>
      ) : null}
    </form>
  );
}

/** How many PEOPLE bought here, when that is a thing we know.
 *
 *  `humanCell` decides, this only renders. The split exists because "0 people"
 *  and "we did not count" are different facts, and a ternary inside a table cell
 *  is where they quietly become one. The dash carries the press's own reason as
 *  its title rather than a phrasing invented here. */
/** The page's one chip style, reused: a seller whose volume is partly paid by
 *  wallets the chain ties to a person. Rendered only when the share is above zero,
 *  because zero here means "not measured", never "nobody" (same rule `humanCell`
 *  keeps). The share rides in the title rather than the cell: this is a classifier
 *  tag, like `sim`, not a new column. */
/** The evidence under the suggestion: the payer's newest purchases, with the
 *  suggested seller and the one to leave marked, and ONE sentence chosen from the
 *  data. "The buyer acted on its own bill" is the claim the whole loop rests on,
 *  so it is read off the settlements rather than asserted by the page. */
function RerouteEvidence({
  recent,
  reroute,
  nowS,
}: {
  recent: TapeRecentRow[];
  reroute: { from: string; to: string };
  nowS: number;
}) {
  const verdict = followedReroute(recent, reroute);
  if (verdict === "none") return null;
  const to = reroute.to.toLowerCase();
  const from = reroute.from.toLowerCase();
  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ margin: 0, fontSize: 13 }}>
        {verdict === "followed" ? (
          <Ed
            x="The latest purchase went to the suggested seller: the buyer read its own bill and changed shops."
            p="The newest purchase went to the cheaper seller, so the buyer read its own bill and switched."
          />
        ) : verdict === "ignored" ? (
          <Ed
            x="The latest purchase still went to the seller to leave; the suggestion stands, unacted."
            p="The newest purchase still went to the dear seller, so the advice has not been taken yet."
          />
        ) : (
          <Ed
            x="The latest purchase went elsewhere; the suggestion stands."
            p="The newest purchase went to a third seller, so the advice still stands."
          />
        )}
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <span className="label">
          <Ed x="Latest purchases" p="Newest buys" />
        </span>
        {recent.map((r, i) => {
          const age = ageWordsAt(r.settledAt, nowS);
          return (
            <span key={`${r.seller}-${r.settledAt}`} className="mono" style={{ fontSize: 12.5, display: "inline-flex", gap: 6, alignItems: "center" }}>
              <AddressChip address={r.seller} copy={false} />
              {r.seller === to ? (
                <span className="chip chip-teal"><Ed x="suggested" p="cheaper" /></span>
              ) : r.seller === from ? (
                <span className="chip chip-sim"><Ed x="the one to leave" p="the dear one" /></span>
              ) : null}
              {age ? <span className="muted">{age}</span> : null}
              {i < recent.length - 1 ? <span className="muted">·</span> : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function HumanMark({ share, of }: { share: number | null | undefined; of: "this payer" | "the window" }) {
  if (share == null || share <= 0) return null;
  // The two tables divide by different things — one payer's fills above, every
  // fill this rotation window below — so the same chip can read 100% and 64% for
  // one seller. The title names the denominator rather than letting a reader
  // hover both and conclude one of them is wrong.
  const scope = of === "this payer" ? "this payer's fills with the seller" : "the seller's fills this rotation window";
  return (
    <span
      className="chip chip-sim"
      style={{ marginLeft: 6 }}
      title={`${(share * 100).toFixed(0)}% of ${scope} came from wallets the chain resolves to a verified person`}
    >
      <Ed x="human" p="real person" />
    </span>
  );
}

function HumanCell({ rating }: { rating: SellerRating | undefined }) {
  const cell = humanCell(rating);
  if (cell.kind === "unmeasured") {
    return (
      <span className="muted" title={cell.note}>
        —
      </span>
    );
  }
  return (
    <span>
      <span className="mono num">
        {cell.humans}
        {cell.payers != null ? (
          <span className="muted">/{cell.payers}</span>
        ) : null}
      </span>
      {cell.allSandbox ? (
        <span
          className="chip chip-sim"
          style={{ marginLeft: 6 }}
          title="Every one of these is a World ID Sandbox identity, not an Orb-verified person."
        >
          sim
        </span>
      ) : null}
    </span>
  );
}

/** A distribution strip: where a seller's fills landed, in basis points.
 *
 *  Bars, not a chart, because there are seven fixed buckets and the shape is
 *  the whole message. The total is the BENCHMARKED count, never the purchase
 *  count: a settlement with no print before it fires no bucket, because "we
 *  could not measure this" is not "this was priced perfectly". */
function Histogram({ row }: { row: SellerRating["histogram"] }) {
  const bars = bucketBars(row);
  const total = bucketTotal(row);
  if (!total) return <span className="muted">…</span>;
  return (
    <span style={{ display: "inline-flex", gap: 2, alignItems: "flex-end", height: 18 }}>
      {bars.map((b) => (
        <span
          key={b.key}
          title={`${b.label} bp: ${b.n}`}
          style={{
            width: 7,
            height: Math.max(2, Math.round(b.frac * 18)),
            background: b.key === "b0" || b.key === "b1" ? "var(--finality)" : "var(--sand)",
            opacity: b.n ? 0.9 : 0.18,
            borderRadius: 1,
          }}
        />
      ))}
    </span>
  );
}

function GradeChip({ rating }: { rating: SellerRating | undefined }) {
  if (!rating?.available) return <span className="muted">…</span>;
  const grade = rating.grade ?? "Unrated";
  if (grade === "Unrated") {
    return (
      <span className="chip chip-sim" title={rating.unrated_reason ?? undefined}>
        unrated
      </span>
    );
  }
  return <span className="chip chip-gold">{grade}</span>;
}

export function TapeView() {
  /* `null` means "whoever the tape says is busiest" — the page's own default,
     kept so clearing the field returns to it rather than to an empty page. */
  const [payer, setPayer] = useState<string | null>(null);

  // A linked result must survive a reload, so the URL is the source on mount.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("payer");
    if (q && ADDRESS.test(q)) setPayer(q.toLowerCase());
  }, []);

  function pick(addr: string | null) {
    setPayer(addr);
    const url = new URL(window.location.href);
    if (addr) url.searchParams.set("payer", addr);
    else url.searchParams.delete("payer");
    window.history.replaceState(null, "", url.toString());
  }

  const { tape, error } = useTape(payer ?? undefined);
  const env = tape;
  const data = env?.data;
  const meta = data?.meta ?? null;
  const tca = data?.tca ?? null;
  const card = tca && tca.available ? (tca as TcaCard) : null;
  const recent = data?.recent ?? [];
  const transport = data?.transport ?? null;
  const nowS = useNow();
  const unreachable = error != null || env?.upstream === "error" || env?.upstream === "timeout";

  const sellers: TapeSeller[] = data?.sellers ?? [];
  const ratings = data?.ratings ?? {};

  /* Two possible sources, one number. The subgraph's own rollup carries
     `weightedSlipTenthBp` — a product that reduces to basis points exactly one
     way — while the settlement-derived fallback has already averaged. Prefer
     whichever is present rather than assuming a field, so the table cannot
     quietly go blank when the operation behind it changes shape. */
  const directory = byWorstFirst(
    sellers.map((s) => {
      const pre = (s as { vw_slippage_bp?: number | null }).vw_slippage_bp;
      return {
        ...s,
        vw_slippage_bp:
          pre !== undefined
            ? pre
            : bpFromWeighted(
                (s as unknown as { weightedSlipTenthBp?: string }).weightedSlipTenthBp,
                s.benchmarkedVolume,
              ),
      };
    }),
  );

  return (
    <>
      <p className="label">
        <Ed x="Machine transaction-cost analysis" p="Did this robot pay a fair price" />
      </p>
      <h1 className="display" style={{ fontSize: 42, marginTop: 6 }}>
        <Ed x="The tape" p="The receipts" />
      </h1>
      <Ed
        as="p"
        className="standfirst"
        style={{ marginTop: 10 }}
        x="Every settlement an agent made, priced against the benchmark it could have seen at that moment."
        p="What a robot paid for computing, next to the fair rate at the time it bought."
      />

      {/* ── is this live? the claim everything else rests on ─────────────── */}
      <section className="section">
        <div className="section-head">
          <h2 className="display" style={{ fontSize: 22 }}>
            <Ed x="Freshness" p="Is this up to date" />
          </h2>
          <span className="label">
            <Ed x="indexed from Arc by The Graph" p="read from the public record by The Graph" />
          </span>
        </div>
        <div className="panel panel-pad">
          {meta ? (
            <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "baseline" }}>
              <span>
                <span className="label" style={{ display: "block" }}>
                  <Ed x="Indexed to block" p="Caught up to block" />
                </span>
                <span className="mono num" style={{ fontSize: 20, color: "var(--sand)" }}>
                  {fmtInt(meta.block)}
                </span>
              </span>
              <span>
                <span className="label" style={{ display: "block" }}>
                  <Ed x="Indexing errors" p="Problems while reading" />
                </span>
                <span className={meta.hasIndexingErrors ? "chip chip-breach" : "chip chip-teal"}>
                  {meta.hasIndexingErrors ? "yes" : "none"}
                </span>
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="label" style={{ display: "block" }}>
                  <Ed x="Subgraph deployment" p="Which copy of the reader" />
                </span>
                <span className="mono muted" style={{ fontSize: 12, wordBreak: "break-all" }}>
                  {meta.deployment}
                </span>
                {/* Named, because a reader cannot tell an API mirror from an indexer.
                    Every slippage figure on this page was computed in the subgraph's
                    own mapping at the block the settlement landed; nothing below
                    recomputes it, which is what makes the provenance worth naming. */}
                <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 2 }}>
                  <Ed x="Subgraph Studio, ethonline v0.2.0: every cost below was benchmarked in the mapping at the settling block" p="a public index of the chain; each cost below was worked out as the purchase landed, not later" />
                </span>
                {/* The press's own count, because The Graph's dashboard counts only
                    gateway queries made with an API key, and the development URL is
                    capped at 3,000 a day. Said plainly which path this is. */}
                {transport && transport.via !== "unset" ? (
                  <span className="mono muted" style={{ display: "block", fontSize: 12, marginTop: 4 }}>
                    {fmtInt(transport.queries)} <Ed x="subgraph queries this boot" p="record lookups since the last restart" /> · {fmtInt(transport.cache_hits)}{" "}
                    <Ed x="served from a 20 s cache" p="answered from a short memory" /> ·{" "}
                    {transport.via === "gateway" ? (
                      <Ed x="via The Graph gateway, counted on the API key" p="through The Graph's paid door, where it is counted" />
                    ) : (
                      <Ed x="via Studio's development URL (3,000/day, counted on no dashboard)" p="through the free test door, which no dashboard counts" />
                    )}
                  </span>
                ) : null}
              </span>
            </div>
          ) : unreachable ? (
            <Ed
              as="p"
              className="muted"
              x="The tape did not answer. Nothing below is being shown as current."
              p="We could not reach the record. Nothing here is being shown as current."
            />
          ) : (
            <div className="awaiting">
              <Ed x="Reading the tape…" p="Loading the record…" />
            </div>
          )}
        </div>
      </section>

      {/* ── what this agent paid ─────────────────────────────────────────── */}
      <section className="section anchor-target" id="cost">
        <div className="section-head">
          <h2 className="display" style={{ fontSize: 22 }}>
            <Ed x="What it cost" p="What the robot paid" />
          </h2>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <PayerField value={payer} onPick={(a) => pick(a)} onReset={() => pick(null)} />
            {card ? (
              <span className="label">
                <Ed x="window" p="looking back" /> {card.window_days}d
              </span>
            ) : null}
          </div>
        </div>

        {card ? (
          <>
            <div className="panel panel-pad" style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", gap: 32, flexWrap: "wrap", alignItems: "baseline" }}>
                <span>
                  <span className="label" style={{ display: "block" }}>
                    <Ed x="Spent" p="Paid out" />
                  </span>
                  <span className="mono num" style={{ fontSize: 24 }}>
                    {money(card.spent_usdc, 6)}
                  </span>
                </span>
                <span>
                  <span className="label" style={{ display: "block" }}>
                    <Ed x="Overpaid vs benchmark" p="Extra it did not need to pay" />
                  </span>
                  <span
                    className="mono num"
                    style={{ fontSize: 24, color: "var(--breach)", fontWeight: 600 }}
                  >
                    {money(card.overpaid_usdc, 6)}
                  </span>
                </span>
                <span>
                  <span className="label" style={{ display: "block" }}>
                    <Ed x="Slippage vs arrival" p="How far above the fair rate" />
                  </span>
                  <span className="mono num" style={{ fontSize: 24, color: "var(--sand)" }}>
                    {bp(card.vw_slippage_bp, 1)}
                  </span>
                </span>
                <span>
                  <span className="label" style={{ display: "block" }}>
                    <Ed x="Priced fills" p="Buys we could check" />
                  </span>
                  <span className="mono num" style={{ fontSize: 24 }}>
                    {fmtInt(card.benchmarked)}
                    <span className="muted" style={{ fontSize: 14 }}> / {fmtInt(card.purchases)}</span>
                  </span>
                </span>
              </div>
              {card.payer ? (
                <div style={{ marginTop: 14 }}>
                  <span className="label">
                    <Ed x="Payer" p="The wallet that bought" />{" "}
                  </span>
                  <AddressChip address={card.payer} />
                </div>
              ) : null}
            </div>

            <div className="table-scroll">
              <table className="sheet">
                <thead>
                  <tr>
                    <th>
                      <Ed x="Seller" p="Bought from" />
                    </th>
                    <th style={{ textAlign: "right" }}>
                      <Ed x="Slippage" p="Above fair rate" />
                    </th>
                    <th style={{ textAlign: "right" }}>
                      <Ed x="Volume" p="Amount" />
                    </th>
                    <th style={{ textAlign: "right" }}>
                      <Ed x="Share" p="Portion" />
                    </th>
                    <th style={{ textAlign: "right" }}>
                      <Ed x="Fills" p="Buys" />
                    </th>
                    <th style={{ textAlign: "right" }}>
                      <Ed x="Ours" p="Our own money" />
                    </th>
                    <th style={{ textAlign: "right" }}>
                      <Ed x="People" p="Verified people" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {card.by_seller.map((r) => (
                    <tr key={r.seller}>
                      <td>
                        <AddressChip address={r.seller} copy={false} />
                        <HumanMark share={r.human_share} of="this payer" />
                      </td>
                      <td
                        className="mono num"
                        style={{
                          textAlign: "right",
                          color:
                            (r.vw_slippage_bp ?? 0) > 0 ? "var(--breach)" : "var(--finality)",
                        }}
                      >
                        {bp(r.vw_slippage_bp, 1)}
                      </td>
                      <td className="mono num" style={{ textAlign: "right" }}>
                        {money(r.volume_usdc, 6)}
                      </td>
                      <td className="mono num muted" style={{ textAlign: "right" }}>
                        {r.volume_share === null ? "…" : `${(r.volume_share * 100).toFixed(1)}%`}
                      </td>
                      <td className="mono num" style={{ textAlign: "right" }}>
                        {fmtInt(r.n)}
                      </td>
                      <td className="mono num muted" style={{ textAlign: "right" }}>
                        {r.synthetic_share === null
                          ? "…"
                          : `${(r.synthetic_share * 100).toFixed(0)}%`}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <HumanCell rating={ratings[r.seller.toLowerCase()]} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {card.reroute ? (
              <div className="panel panel-pad" style={{ marginTop: 18 }}>
                <p className="label">
                  <Ed x="Reroute" p="A cheaper way to buy the same thing" />
                </p>
                <p style={{ marginTop: 8 }}>
                  <AddressChip address={card.reroute.from} copy={false} />
                  <span className="muted" style={{ margin: "0 10px" }}>
                    →
                  </span>
                  <AddressChip address={card.reroute.to} copy={false} />
                  <span className="mono num" style={{ marginLeft: 16, color: "var(--finality)" }}>
                    {bp(card.reroute.saving_bp, 1)} · {money(card.reroute.saving_usdc, 6)}
                  </span>
                </p>
                <Ed
                  as="p"
                  className="muted"
                  style={{ marginTop: 8, fontSize: 13 }}
                  x="Arithmetic on past fills in this window. A suggestion, not a promise about the next one."
                  p="Worked out from past buys. It is a suggestion, not a promise."
                />
                {/* Did anyone ACT on it? Read off the tape, never assumed: the newest
                    purchase either landed on the suggested seller, on the one to
                    leave, or somewhere else. This row is the loop closing — or
                    not — in the buyer's own settlements. */}
                <RerouteEvidence recent={recent} reroute={card.reroute} nowS={nowS} />
              </div>
            ) : null}
          </>
        ) : unreachable ? (
          <p className="muted">
            <Ed
              x="The tape did not answer, so no cost is shown. An outage is not a clean bill."
              p="We could not reach the record, so nothing is shown. No news is not good news."
            />
          </p>
        ) : tca != null && !tca.available ? (
          /* The state this page could not previously express. A wallet with no
             priced fills used to fall through to "Reading settlements…" and sit
             there forever, which reads as a slow page rather than as an answer.
             "Nothing to measure" and "we could not measure" are different facts
             and the reason says which one this is. */
          <p className="muted">
            <Ed
              x="Nothing to grade for this wallet on the indexed tape: "
              p="There is nothing to check for this wallet yet: "
            />
            <span className="mono" style={{ fontSize: 13 }}>
              {tca.reason}
            </span>
          </p>
        ) : (
          <div className="awaiting">
            <Ed x="Reading settlements…" p="Loading the buys…" />
          </div>
        )}
      </section>

      {/* ── the sellers ──────────────────────────────────────────────────── */}
      <section className="section anchor-target" id="sellers">
        <div className="section-head">
          <h2 className="display" style={{ fontSize: 22 }}>
            <Ed x="Who sold it" p="The sellers" />
          </h2>
          <span className="label">
            <Ed x="graded on the same tape" p="scored on the same record" />
          </span>
        </div>
        {directory.length ? (
          <div className="table-scroll">
            <table className="sheet">
              <thead>
                <tr>
                  <th>
                    <Ed x="Seller" p="Seller" />
                  </th>
                  <th>
                    <Ed x="Grade" p="Score" />
                  </th>
                  <th style={{ textAlign: "right" }}>
                    <Ed x="Slippage" p="Above fair rate" />
                  </th>
                  <th style={{ textAlign: "right" }}>
                    <Ed x="Volume" p="Amount sold" />
                  </th>
                  <th style={{ textAlign: "right" }}>
                    <Ed x="Fills" p="Sales" />
                  </th>
                  <th>
                    <Ed x="Distribution" p="Spread of prices" />
                  </th>
                  <th style={{ textAlign: "right" }}>
                    <Ed x="Ours" p="Our own money" />
                  </th>
                  <th style={{ textAlign: "right" }}>
                    <Ed x="Coverage" p="How much was scored" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {directory.map((s) => {
                  const r = ratings[s.id.toLowerCase()];
                  return (
                    <tr key={s.id}>
                      <td>
                        <AddressChip address={s.id} copy={false} />
                        <HumanMark share={s.humanShare} of="the window" />
                      </td>
                      <td>
                        <GradeChip rating={r} />
                      </td>
                      <td
                        className="mono num"
                        style={{
                          textAlign: "right",
                          color: (s.vw_slippage_bp ?? 0) > 0 ? "var(--breach)" : "var(--finality)",
                        }}
                      >
                        {bp(s.vw_slippage_bp, 1)}
                      </td>
                      <td className="mono num" style={{ textAlign: "right" }}>
                        {money(usdc6(s.totalVolume) ?? 0, 6)}
                      </td>
                      <td className="mono num" style={{ textAlign: "right" }}>
                        {fmtInt(s.settlementCount)}
                      </td>
                      <td>
                        <Histogram row={r?.histogram} />
                      </td>
                      <td className="mono num muted" style={{ textAlign: "right" }}>
                        {s.syntheticShare == null
                          ? "…"
                          : `${(s.syntheticShare * 100).toFixed(0)}%`}
                      </td>
                      <td className="mono num muted" style={{ textAlign: "right" }}>
                        {r?.weight_covered_pct == null ? "…" : `${r.weight_covered_pct}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : unreachable ? (
          <p className="muted">
            <Ed x="The tape did not answer." p="We could not reach the record." />
          </p>
        ) : (
          <div className="awaiting">
            <Ed x="Reading sellers…" p="Loading sellers…" />
          </div>
        )}
        <Ed
          as="p"
          className="muted"
          style={{ marginTop: 12, fontSize: 13 }}
          x={`A grade needs ${MIN_RATED_N} priced fills, and rests on the share of the method shown under Coverage, never on all of it.`}
          p={
            <>
              A score needs {MIN_RATED_N} checked sales, each judged against{" "}
              <Term k="arrival-price">the price at the time</Term>. Coverage says how much of
              the scoring it rests on.
            </>
          }
        />
      </section>

      {/* ── the control group ────────────────────────────────────────────── */}
      <section className="section anchor-target" id="control">
        <div className="section-head">
          <h2 className="display" style={{ fontSize: 22 }}>
            <Ed x="The control" p="The sanity check" />
          </h2>
        </div>
        <div className="panel panel-pad">
          {data?.control ? (
            <>
              <div style={{ display: "flex", gap: 32, flexWrap: "wrap", alignItems: "baseline" }}>
                <span>
                  <span className="label" style={{ display: "block" }}>
                    <Ed x="Venue fills measured" p="Trades checked" />
                  </span>
                  <span className="mono num" style={{ fontSize: 24 }}>
                    {fmtInt(data.control.fills)}
                  </span>
                </span>
                <span>
                  <span className="label" style={{ display: "block" }}>
                    <Ed x="Non-zero slippage" p="Any that looked dear" />
                  </span>
                  <span
                    className="mono num"
                    style={{
                      fontSize: 24,
                      color: data.control.nonZero ? "var(--breach)" : "var(--finality)",
                    }}
                  >
                    {fmtInt(data.control.nonZero)}
                  </span>
                </span>
              </div>
              <Ed
                as="p"
                style={{ marginTop: 12 }}
                x="The venue fills at the printed rate, so a fill IS its own benchmark and its slippage can only be zero. That is the point: it is the control that shows the spread above is real dispersion, not an artefact of the method."
                p="These trades happen at the official rate, so they can never look dear. That is why they are the check: the differences above are real."
              />
            </>
          ) : (
            <div className="awaiting">
              <Ed x="Reading the control…" p="Loading the check…" />
            </div>
          )}
        </div>
      </section>
    </>
  );
}
