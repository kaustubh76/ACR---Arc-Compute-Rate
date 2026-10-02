"use client";

import { useState } from "react";
import { Ed } from "@/components/Ed";
import { EscalationActions } from "@/components/spend/EscalationActions";
import { Term } from "@/components/Term";
import { useBusinesses, useStatement } from "@/lib/useLive";
import { ageWords, fmtInt, fmtPrice, shortAddr } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import type { SpendBudget, SpendDecision, Statement } from "@/lib/types";

/* The Spend Statement — the owner's page.

   WHAT IS WAITING ON THEM COMES FIRST. Every other section describes what the
   agent already did; the escalation queue is the only part of this page that
   needs a person, so it is the only part above the summary. A statement that
   opened with totals would bury the one thing it is asking for.

   THE DOLLAR FIGURES AND THE BASIS-POINT FIGURES COME FROM DIFFERENT PLACES,
   and the page says so where they are rendered rather than in a footnote.
   Savings are USDC and come from a reroute, where another seller was named at
   a lower price for the same service. The index appears only as market
   context, in basis points, because `anchors/GAP.md` records its reference
   level 20x to 1159x off real market prices: the bp is scale-invariant and the
   dollars would not be. Collapsing the two into one "total saved" is the one
   edit this page must never take.

   ZERO IS A RESULT. With nothing onboarded the page says that in words. A
   traction surface that renders blank for zero looks broken, and "we have not
   onboarded anybody yet" is both true and the thing we are working on. */

const INTENT: Record<string, { cls: string; x: string; p: string }> = {
  pay: { cls: "chip-teal", x: "paid", p: "paid" },
  hold: { cls: "chip-sky", x: "held", p: "waiting on purpose" },
  reroute: { cls: "chip-gold", x: "rerouted", p: "bought cheaper elsewhere" },
  escalate: { cls: "chip-breach", x: "escalated", p: "needs a person" },
  refuse: { cls: "chip-breach", x: "refused", p: "refused" },
};

/** Every USDC figure on this page goes through `fmtPrice`, never a fixed number
 *  of decimals. `lib/format.ts` records why: five fixed decimals is five
 *  significant figures for a ~0.49 print and TWO for a ~0.0021 one, which once
 *  rendered a corridor's mid and ask as the identical string. A spend statement
 *  spans a $0.0001 machine call and a $150 cluster-hour, so constant
 *  significant figures is the only honest choice here.
 *
 *  A missing figure becomes the house's `NOT_A_NUMBER` ellipsis rather than a
 *  dash — `format.ts` moved off the em dash deliberately, because it read as
 *  generic placeholder filler across every table. */
function price(n: number | null | undefined): string {
  return fmtPrice(typeof n === "number" ? n : NaN);
}

/** `shortAddr` throws on undefined and returns "" for "", so the call sites
 *  decide what an absent counterparty looks like rather than the formatter. */
function who(a: string | null | undefined): string {
  return a ? shortAddr(a) : fmtPrice(NaN);
}

/** One decision, with the rule that produced it. The rule is the whole point:
 *  it is what a reviewer reads instead of reconstructing the reasoning. */
function DecisionRow({ d }: { d: SpendDecision }) {
  const kind = INTENT[d.intent] ?? { cls: "chip-sky", x: d.intent, p: d.intent };
  return (
    <tr>
      <td>
        <span className={`chip ${kind.cls}`}>
          <Ed x={kind.x} p={kind.p} />
        </span>
      </td>
      <td className="mono">{price(d.billed_usdc)}</td>
      <td className="mono">{price(d.par_usdc)}</td>
      <td className="mono">{price(d.saving_usdc)}</td>
      <td className="mono">{who(d.reroute_to || d.vendor)}</td>
      <td>{d.rule}</td>
    </tr>
  );
}

function BudgetRow({ b }: { b: SpendBudget }) {
  if (!b.configured) {
    return (
      <tr>
        <td className="mono">{b.category}</td>
        <td colSpan={3}>
          <span className="chip chip-gold">
            <Ed x="no budget set on chain" p="nobody has set a limit for this yet" />
          </span>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td className="mono">{b.category}</td>
      <td className="mono">{price(b.cap_usdc)}</td>
      <td className="mono">{price(b.spent_usdc)}</td>
      <td className="mono">{price(b.remaining_usdc)}</td>
    </tr>
  );
}

function StatementBody({ st, onSettled }: { st: Statement; onSettled: () => void }) {
  const s = st.spend;
  const ctx = st.market_context;

  return (
    <>
      {st.escalations.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>
              <Ed x="Waiting on you" p="Waiting for you" />
            </h2>
            <span className="label">{fmtInt(st.escalations.length)}</span>
          </div>
          <p className="standfirst">
            <Ed
              x="Decisions the agent declined to make on its own authority."
              p="The agent stopped and asked instead of deciding these itself."
            />
          </p>
          {/* One block per escalation rather than table rows, because each
              carries a form and a form inside a scrolling cell is a control
              nobody can reach on a phone. */}
          {st.escalations.map((d) => (
            <div className="panel panel-pad" key={`${d.obligation_id}-${d.at}`}>
              <div className="section-head">
                <h3 className="mono">
                  {price(d.billed_usdc)} USDC · {who(d.vendor)}
                </h3>
                <span className="chip chip-breach">
                  <Ed x="needs you" p="needs you" />
                </span>
              </div>
              <p className="standfirst">{d.rule}</p>
              <EscalationActions
                business={st.business.slug}
                decision={d}
                onSettled={onSettled}
              />
            </div>
          ))}
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>
            <Ed x="This period" p="Lately" />
          </h2>
          <span className="label">{st.period_days}d</span>
        </div>
        <p className="standfirst">
          <Ed
            x="What the agent decided on its own authority, and what it sent to a person."
            p="What the agent settled by itself, and what it passed to a person."
          />
        </p>
        <div className="panel panel-pad">
          <div className="table-scroll">
            <table>
              <tbody>
                <tr>
                  <td>
                    <Ed x="Decided" p="Handled by the agent" />
                  </td>
                  <td className="mono">{fmtInt(s.decided)}</td>
                </tr>
                <tr>
                  <td>
                    <Ed x="Escalated" p="Passed to a person" />
                  </td>
                  <td className="mono">{fmtInt(s.escalated)}</td>
                </tr>
                <tr>
                  <td>
                    <Ed x="Paid" p="Paid out" />
                  </td>
                  <td className="mono">{price(s.paid_usdc)}</td>
                </tr>
                <tr>
                  <td>
                    <Ed
                      x="Saved by rerouting"
                      p="Saved by buying from somebody cheaper"
                    />
                  </td>
                  <td className="mono">{price(s.saved_usdc)}</td>
                </tr>
                <tr>
                  <td>
                    <Ed
                      x="Consumption discrepancies"
                      p="Bills for more than we counted"
                    />
                  </td>
                  <td className="mono">{fmtInt(s.consumption_discrepancies)}</td>
                </tr>
                <tr>
                  <td>
                    <Ed x="Unmetered bills" p="Bills we had no record for" />
                  </td>
                  <td className="mono">{fmtInt(s.unmetered)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="standfirst">
            <Ed
              x="Savings are measured against the cheapest price another seller was actually offering."
              p="Savings compare what we paid to the cheapest real offer we could see."
            />
          </p>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>
            <Ed x="Budgets" p="Limits" />
          </h2>
          <span className="label">
            {st.spends ? "on chain" : "not spending"}
          </span>
        </div>
        <p className="standfirst">
          {st.spends ? (
            <Ed
              x="Read from the contract, which is what enforces them."
              p="Read from the contract that actually enforces them."
            />
          ) : (
            <Ed
              x="No wallet connected, so the agent can price and meter here but cannot pay."
              p="No wallet connected, so the agent can check prices but cannot pay."
            />
          )}
        </p>
        {st.budgets.length > 0 && (
          <div className="panel panel-pad">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>
                      <Ed x="Category" p="What for" />
                    </th>
                    <th>
                      <Ed x="Cap" p="Limit" />
                    </th>
                    <th>
                      <Ed x="Spent" p="Used" />
                    </th>
                    <th>
                      <Ed x="Left" p="Left" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {st.budgets.map((b) => (
                    <BudgetRow key={b.category} b={b} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>
            <Ed x="Every decision" p="Everything it did" />
          </h2>
          <span className="label">{fmtInt(s.decisions)}</span>
        </div>
        <p className="standfirst">
          <Ed
            x="Each row carries the rule that produced it, so the reasoning is read rather than reconstructed."
            p={
              <>
                Each row says which rule decided it, and what the{" "}
                <Term k="par">going rate</Term> was, so you can read the reason.
              </>
            }
          />
        </p>
        <div className="panel panel-pad">
          {st.recent.length === 0 ? (
            <p className="standfirst">
              <Ed
                x="Nothing yet. The agent writes a row for every outcome, including the refusals."
                p="Nothing yet. The agent records every outcome, including the refusals."
              />
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>
                      <Ed x="Outcome" p="What happened" />
                    </th>
                    <th>
                      <Ed x="Billed" p="Asked for" />
                    </th>
                    <th>
                      <Ed x="Par" p="Going rate" />
                    </th>
                    <th>
                      <Ed x="Saved" p="Saved" />
                    </th>
                    <th>
                      <Ed x="Counterparty" p="Who" />
                    </th>
                    <th>
                      <Ed x="Rule" p="Why" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {st.recent.map((d) => (
                    <DecisionRow key={`${d.obligation_id}-${d.at}`} d={d} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>
            <Ed x="Market context" p="How it compares" />
          </h2>
          <span className="label">bp</span>
        </div>
        {ctx.available ? (
          <div className="panel panel-pad">
            <p className="standfirst">
              <Ed
                x="Against the published index, in basis points. The index sets a scale, not a price in dollars, so no figure here is money."
                p="Against our published rate, as a percentage. This part is not money."
              />
            </p>
            <div className="table-scroll">
              <table>
                <tbody>
                  <tr>
                    <td>
                      <Ed x="Purchases" p="Buys" />
                    </td>
                    <td className="mono">{fmtInt(ctx.purchases ?? NaN)}</td>
                  </tr>
                  <tr>
                    <td>
                      <Ed x="Against the index" p="Versus our rate" />
                    </td>
                    <td className="mono">
                      {typeof ctx.vw_slippage_bp === "number"
                        ? `${ctx.vw_slippage_bp.toFixed(1)} bp`
                        : "—"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="panel panel-pad">
            <p className="standfirst">
              <Ed
                x="No indexed history for this treasury yet."
                p="We have no published history for this wallet yet."
              />
            </p>
          </div>
        )}
      </section>
    </>
  );
}

export function SpendView() {
  const nowS = useNow();
  const { businesses, error: listError } = useBusinesses();
  const rows = businesses?.data?.businesses ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const slug = chosen ?? rows[0]?.slug ?? null;
  const { statement, error: stError, refresh } = useStatement(slug);
  const st = statement?.data ?? null;

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2>
            <Ed x="Spend" p="The money agent" />
          </h2>
          {/* fetchedAt is epoch MILLISECONDS and ageWords takes an AGE IN
              SECONDS, so it is converted here. The `nowS > 0` gate is not
              decoration: useNow() returns 0 during SSR on purpose, and
              rendering a wall-clock age server-side would differ from the
              client and break hydration. app/ops/view.tsx does both. */}
          {businesses?.fetchedAt && nowS > 0 ? (
            <span className="label">
              {ageWords(Math.max(0, nowS - Math.round(businesses.fetchedAt / 1000)))}
            </span>
          ) : null}
        </div>
        <p className="standfirst standfirst-block">
          <Ed
            x="An agent holds this business's USDC inside a budget it cannot exceed, meters what was actually consumed, checks every price against what others are charging, and pays what clears policy."
            p="An agent holds the money, checks every bill against real prices, and pays the ones that pass the rules."
          />
        </p>

        {listError ? (
          <div className="panel panel-pad">
            <p className="standfirst">
              <Ed
                x="The press did not answer, so this page is showing nothing rather than something stale."
                p="We could not reach the service, so this shows nothing rather than old news."
              />
            </p>
          </div>
        ) : rows.length === 0 ? (
          /* Zero is a result, and it is the current one. Saying it in words
             beats an empty page that reads as broken. */
          <div className="panel panel-pad">
            <p className="standfirst">
              <Ed
                x="No businesses onboarded yet. Each one is a treasury address, a budget, and a signed consent to be named."
                p="No businesses yet. Each one is a wallet, a set of limits, and permission to be named."
              />
            </p>
          </div>
        ) : (
          <div className="panel panel-pad">
            {/* A segmented group, not a table of links: `.segmented button.on`
                is the stylesheet's own selected state and `aria-pressed` makes
                the choice audible. The first draft used a bespoke `.is-on`,
                which this stylesheet does not define — the same dangling
                className that once shipped `table`, `teal` and `wallet-panel`
                styling nothing at all. */}
            {rows.length > 1 && (
              <div className="segmented" role="group" aria-label="business">
                {rows.map((b) => (
                  <button
                    key={b.slug}
                    type="button"
                    className={b.slug === slug ? "on" : ""}
                    aria-pressed={b.slug === slug}
                    onClick={() => setChosen(b.slug)}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>
                      <Ed x="Business" p="Business" />
                    </th>
                    <th>
                      <Ed x="How it arrived" p="How we met them" />
                    </th>
                    <th>
                      <Ed x="Chain" p="Network" />
                    </th>
                    <th>
                      <Ed x="Spending" p="Can it pay?" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.slug} aria-current={b.slug === slug ? "true" : undefined}>
                      <td>{b.label}</td>
                      <td className="mono">{b.tier}</td>
                      <td className="mono">{b.chain}</td>
                      <td>
                        <span
                          className={`chip ${b.spends ? "chip-teal" : "chip-sky"}`}
                        >
                          {b.spends ? (
                            <Ed x="yes" p="yes" />
                          ) : (
                            <Ed x="measured only" p="watching only" />
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {stError && slug ? (
        <section className="section">
          <div className="panel panel-pad">
            <p className="standfirst">
              <Ed
                x="This statement could not be read."
                p="We could not load this statement."
              />
            </p>
          </div>
        </section>
      ) : null}

      {st ? <StatementBody st={st} onSettled={() => void refresh()} /> : null}
    </>
  );
}
