"use client";

import { AddressChip } from "@/components/chain/AddressChip";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { fmtInt, money } from "@/lib/format";
import {
  MIN_RATED_N,
  bp,
  bpFromWeighted,
  bucketBars,
  bucketTotal,
  byWorstFirst,
  usdc6,
} from "@/lib/tape";
import type { SellerRating, TapeSeller, TcaCard } from "@/lib/tape";
import { useTape } from "@/lib/useLive";

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
  const { tape, error } = useTape();
  const env = tape;
  const data = env?.data;
  const meta = data?.meta ?? null;
  const tca = data?.tca ?? null;
  const card = tca && tca.available ? (tca as TcaCard) : null;
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
            <Ed x="indexed from Arc" p="read from the public record" />
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
                  <Ed x="Deployment" p="Which copy of the reader" />
                </span>
                <span className="mono muted" style={{ fontSize: 12, wordBreak: "break-all" }}>
                  {meta.deployment}
                </span>
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
          {card ? (
            <span className="label">
              <Ed x="window" p="looking back" /> {card.window_days}d
            </span>
          ) : null}
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
                  </tr>
                </thead>
                <tbody>
                  {card.by_seller.map((r) => (
                    <tr key={r.seller}>
                      <td>
                        <AddressChip address={r.seller} copy={false} />
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
