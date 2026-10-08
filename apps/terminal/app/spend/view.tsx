"use client";

import Link from "next/link";
import { useState } from "react";
import { Ed } from "@/components/Ed";
import { EscalationActions } from "@/components/spend/EscalationActions";
import { Term } from "@/components/Term";
import { useBusinesses, useLedgerAudit, useStatement } from "@/lib/useLive";
import { ageWords, fmtInt, fmtPrice, shortAddr } from "@/lib/format";
import { CHAIN, CHAIN_TESTNET, txUrl } from "@/lib/chain";
import { checkHref } from "@/lib/checkLink";
import { useNow } from "@/lib/useNow";
import type {
  LedgerAudit,
  SpendBudget,
  SpendDecision,
  SpendLiquidity,
  Statement,
} from "@/lib/types";

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
   level 20x to 1250x off real market prices: the bp is scale-invariant and the
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

/** A `pay` that sent nothing CLEARED POLICY; it did not pay.
 *
 *  This page rendered a green "paid" chip on six decisions whose `paid_usdc`
 *  was 0.0 — they were dry runs. The beancount export already said "cleared
 *  policy, not sent" about the same records, so two surfaces disagreed about
 *  one fact and the one a reviewer opens was the wrong one. The wording is
 *  copied from `ledger_export.py` deliberately, so they cannot drift again. */
function outcome(d: SpendDecision): { cls: string; x: string; p: string } {
  if (d.intent === "pay" && !(d.paid_usdc && d.paid_usdc > 0)) {
    return {
      cls: "chip-sky",
      x: "cleared policy, not sent",
      p: "allowed, but not paid yet",
    };
  }
  return INTENT[d.intent] ?? { cls: "chip-sky", x: d.intent, p: d.intent };
}

/** The counterparty screen, per decision.
 *
 *  `unknown` gets its own tier and never reads as `clear` — the same rule
 *  `counterparty.py` enforces in the data, because a screening service that
 *  timed out is not a clean bill of health. Absent means no screen was offered
 *  for that decision, which is a third thing again. */
const SCREEN: Record<string, { cls: string; x: string; p: string }> = {
  clear: { cls: "chip-teal", x: "clear", p: "checked, fine" },
  flagged: { cls: "chip-breach", x: "flagged", p: "on a watchlist" },
  unknown: { cls: "chip-gold", x: "not screened", p: "could not check" },
};

/** The agreement check's verdicts, in English.
 *
 *  `commitments.py` calls each one "a sentence a reviewer can act on" and this
 *  page rendered none of them: the verdict was computed, recorded and hashed
 *  into the wallet while staying invisible — which is also why `held_back_usdc`
 *  reached the summary with no row a reader could point at. */
const AGREED: Record<string, { cls: string; x: string; p: string }> = {
  within: { cls: "chip-teal", x: "within the agreement", p: "matches what we agreed" },
  over_total: { cls: "chip-breach", x: "over the agreed total", p: "more than we agreed in total" },
  over_unit_price: { cls: "chip-breach", x: "over the agreed rate", p: "a higher rate than we agreed" },
  over_quantity: { cls: "chip-breach", x: "over the agreed quantity", p: "more than we asked for" },
  outside_window: { cls: "chip-gold", x: "outside the agreed dates", p: "outside the dates we agreed" },
  no_commitment: { cls: "chip-gold", x: "no agreement on file", p: "nothing written down for this" },
};

/** Why the benchmark could not answer.
 *
 *  A par of "…" with no reason reads as a bug. Each of these is a fact about
 *  the market instead, and the one that matters most is `ONE_SELLER`: a single
 *  quote is a price, not a benchmark, and `anchors/GAP.md` is the record of
 *  what happens when the two are confused. */
const PAR_REASON: Record<string, { x: string; p: string }> = {
  NO_QUOTES: { x: "nobody else quoted this unit", p: "nobody else was quoting this" },
  ONE_SELLER: { x: "one seller, so no benchmark", p: "only one seller, so nothing to compare" },
  NO_INDEPENDENT_SELLER: {
    x: "no independent seller to compare against",
    p: "no unrelated seller to compare with",
  },
  NO_QUANTITY: { x: "no quantity, so no unit price", p: "no amount given, so no unit price" },
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

/** A consumed quantity, in the service's own unit.
 *
 *  Through `fmtPrice` rather than raw: these span 0.08 to 24 in one table, and
 *  constant significant figures is the only arithmetic in the house that holds
 *  across two orders of magnitude. Raw rendered `0.09999999999999999`. It is
 *  named for prices because that is where the problem was first found, not
 *  because the maths is only valid for money. */
function qty(n: number): string {
  return fmtPrice(n);
}

/** When the soonest dated bill falls, against the clock the figure was
 *  computed on.
 *
 *  NOT `ageWords`, which only looks backwards ("3 hr ago"), and the whole point
 *  of this figure is what is COMING. Past due renders as past due rather than
 *  as a negative interval, because `liquidity.assess` deliberately counts an
 *  overdue bill IN — "an overdue bill is the most due thing there is" — and a
 *  column reading "in -2 days" would bury the one row that matters most.
 *
 *  Against `statement.as_of`, not the browser clock. The horizon was applied
 *  server-side at that instant, so the prose and the total it sits beside
 *  measure from the same moment; a live clock here would drift the words out of
 *  step with the number and needs an SSR guard besides. */
function dueWords(atS: number | null, asOf: number): string | null {
  if (atS == null || !asOf) return null;
  const left = atS - asOf;
  if (left < 0) return "past due";
  if (left < 3_600) return "within the hour";
  // A day is where a reader stops counting in hours. The first cut was two
  // days, and the same bill then read "in 48 hr" in the Cash row and "in 2
  // days" on its own card — both correct, and together they look like two
  // different facts.
  if (left < 86_400) return `in ${Math.round(left / 3_600)} hr`;
  return `in ${Math.round(left / 86_400)} days`;
}

/** `shortAddr` throws on undefined and returns "" for "", so the call sites
 *  decide what an absent counterparty looks like rather than the formatter. */
function who(a: string | null | undefined): string {
  return a ? shortAddr(a) : fmtPrice(NaN);
}

/** One decision: billed, metered, par, screened, and the rule that produced it.
 *
 *  THE COLUMNS ARE THE PRODUCT'S CLAIM. `billed · metered · par · paid · rule`
 *  is what this agent says it writes down, and the first version of this table
 *  showed billed, par and the saving while leaving the METER invisible — the
 *  independent count is Prior Art #06, the thing the whole build is named
 *  after, and it had already caught a vendor underbilling on real data without
 *  the page ever saying so. The screen was invisible for the same reason. */
function DecisionRow({ d, explorer }: { d: SpendDecision; explorer: string }) {
  const kind = outcome(d);
  const screen = d.screen_risk ? SCREEN[d.screen_risk] : null;
  const over = typeof d.discrepancy === "number" && d.discrepancy > 0;
  const under = typeof d.discrepancy === "number" && d.discrepancy < 0;
  const service = d.resource ? d.resource.split("/").pop() : "";
  // Against `d.at`, the clock check 7 compared the due date to when it decided.
  // The browser's clock would answer a different question — "is it due now" —
  // and silently rewrite what the agent is recorded as having seen.
  const dueNote = dueWords(d.due_at ?? null, d.at);

  return (
    <tr>
      <td>
        <span className={`chip ${kind.cls}`}>
          <Ed x={kind.x} p={kind.p} />
        </span>
      </td>
      <td className="mono">{price(d.billed_usdc)}</td>

      {/* The meter: our own count against theirs. A positive difference means
          they billed for more than we consumed, which is the case this whole
          product exists to catch, so it gets the alarm colour. */}
      <td className="mono">
        {typeof d.metered_quantity === "number" ? (
          <>
            {qty(d.metered_quantity)}
            {typeof d.vendor_quantity === "number" &&
            d.vendor_quantity !== d.metered_quantity ? (
              <>
                {" / "}
                <span className={`chip ${over ? "chip-breach" : "chip-sky"}`}>
                  {qty(d.vendor_quantity)}
                </span>
              </>
            ) : null}
          </>
        ) : (
          /* None is not zero. Zero would assert we consumed nothing and make
             every bill look fraudulent; `operator.py` makes the same refusal. */
          <span className="chip chip-gold">
            <Ed x="no record" p="no record" />
          </span>
        )}
        {/* THE UNIT, which this column had been printing numbers without.
            "5.0" against "5.0" is not a reading: `$/1k tokens` and `$/GPU-sec`
            are different markets, and `operator.py` says the unit is what
            decides WHICH one was consulted. */}
        {d.unit ? <div className="label mono">{d.unit}</div> : null}
        {/* The same gap in money, on the vendor's own arithmetic. The quantity
            difference above says they billed for more than we counted; this
            says what that was worth, which is the figure `overbilled_usdc` on
            the summary is made of. */}
        {typeof d.discrepancy_usdc === "number" && d.discrepancy_usdc !== 0 ? (
          <div className="label mono">
            {price(Math.abs(d.discrepancy_usdc))} USDC
          </div>
        ) : null}
      </td>

      <td className="mono">
        {price(d.par_usdc)}
        {typeof d.best_usdc === "number" ? (
          <>
            {" · "}
            <Ed x="best" p="cheapest" />
            {" "}
            {price(d.best_usdc)}
          </>
        ) : null}
        {/* The gap in USDC as well as in bp. The ratio is the scale-invariant
            one and stays the basis of every claim; the dollars are the unit a
            reader budgets in, and they were computed and dropped. */}
        {typeof d.over_par_usdc === "number" && d.over_par_usdc > 0 ? (
          <div className="label">
            <Ed
              x={`${price(d.over_par_usdc)} over`}
              p={`${price(d.over_par_usdc)} more than the going rate`}
            />
          </div>
        ) : null}
        {/* HOW DEEP THE BENCHMARK WAS. One quote is a price, not a par, and a
            figure that does not say how many sellers stood behind it invites
            exactly the confidence `anchors/GAP.md` exists to withhold. */}
        {typeof d.par_sellers === "number" && d.par_sellers > 0 ? (
          <div className="label">
            <Ed
              x={`${fmtInt(d.par_sellers)} sellers`}
              p={`compared with ${fmtInt(d.par_sellers)} sellers`}
            />
          </div>
        ) : null}
        {d.par_reason && PAR_REASON[d.par_reason] ? (
          <div className="label">
            <Ed {...PAR_REASON[d.par_reason]} />
          </div>
        ) : d.par_reason ? (
          <div className="label mono">{d.par_reason}</div>
        ) : null}
      </td>

      {/* `wrap`, because `screen_matched` is a LIST and its joined length has
          no bound, while `.sheet` brought `nowrap` with it. The 640px mono
          release targets `td.mono`, which this cell is not. */}
      <td className="wrap">
        {screen ? (
          <span className={`chip ${screen.cls}`}>
            <Ed x={screen.x} p={screen.p} />
          </span>
        ) : (
          <span className="chip chip-gold">
            <Ed x="no screen" p="not checked" />
          </span>
        )}
        {d.screen_matched && d.screen_matched.length > 0 ? (
          <div className="mono">{d.screen_matched.join(" · ")}</div>
        ) : null}
        {/* WHICH screen said so. A verdict without its source is a claim
            without a basis: "clear" from a sanctions dataset and "clear" from a
            local list of three addresses are not the same assurance, and the
            record used to drop the difference before anyone could read it. */}
        {d.screen_backend ? (
          <div className="label mono">{d.screen_backend}</div>
        ) : null}
        {/* And WHY. The backend names who answered; this names what they
            actually had to say, which is the difference between a dataset
            returning no match and a denylist of zero addresses returning
            nothing because it is empty. */}
        {d.screen_reason ? <div className="label">{d.screen_reason}</div> : null}
      </td>

      <td>
        {d.rule}
        {/* The notes are where the gaps live: a dry run, an unscreened
            counterparty, a price nobody could benchmark. Invisible notes are
            how a gap becomes a silent claim. */}
        {d.notes && d.notes.length > 0 ? (
          <div className="label">{d.notes.join(" · ")}</div>
        ) : null}
        {under ? (
          <div className="label">
            <Ed
              x="they billed under our count"
              p="they asked for less than we used"
            />
          </div>
        ) : null}
        {/* WAS THERE AN AGREEMENT, AND DID THE BILL MATCH IT. Check 4b, and the
            one check whose verdict never reached a surface: it was computed,
            written into the record and hashed into the wallet, and an owner
            could read `held_back_usdc` on the summary above with no row to
            point at as the reason. */}
        {d.commitment_verdict ? (
          <div className="label">
            <span
              className={`chip ${AGREED[d.commitment_verdict]?.cls ?? "chip-gold"}`}
            >
              {AGREED[d.commitment_verdict] ? (
                <Ed
                  x={AGREED[d.commitment_verdict].x}
                  p={AGREED[d.commitment_verdict].p}
                />
              ) : (
                d.commitment_verdict
              )}
            </span>
            {typeof d.over_commitment_usdc === "number" &&
            d.over_commitment_usdc > 0 ? (
              <>
                {" "}
                <span className="mono">
                  {price(d.over_commitment_usdc)} USDC
                </span>
              </>
            ) : null}
          </div>
        ) : null}
        {/* What the agent ADVISED, on a decision it handed over. "How often the
            human agreed" is one of the four things RFB 4 asks this product to
            report, and the recommendation it is measured against was recorded
            and never shown. */}
        {d.recommended_intent && INTENT[d.recommended_intent] ? (
          <div className="label">
            <Ed x="advised" p="the agent suggested" />
            {" "}
            <span className={`chip ${INTENT[d.recommended_intent].cls}`}>
              <Ed
                x={INTENT[d.recommended_intent].x}
                p={INTENT[d.recommended_intent].p}
              />
            </span>
          </div>
        ) : null}
        {d.early_pay_discount && d.early_pay_discount > 0 ? (
          /* Not through `pct`, which prefixes a `+` to anything non-negative
             and so rendered a discount as "+2.0% off for paying early". */
          <div className="label">
            <Ed
              x={`${(d.early_pay_discount * 100).toFixed(1)}% off for paying early`}
              p={`${(d.early_pay_discount * 100).toFixed(1)}% cheaper if paid early`}
            />
          </div>
        ) : null}
        {/* One line for the facts a reader reconciles against: what service,
            the vendor's own reference, where it went instead, when it was due,
            who acted, how the money moved, and the transaction. Woven into the
            line that was already here rather than seven more columns. */}
        <div className="label mono">
          {service}
          {d.invoice_ref ? ` · ${d.invoice_ref}` : ""}
          {d.reroute_to ? ` → ${shortAddr(d.reroute_to)}` : ""}
          {dueNote ? ` · ${dueNote}` : ""}
          {/* `agent` on nearly every row, and that IS the claim: a record that
              does not name who acted cannot support "settled without a human
              touching them" in either direction. */}
          {` · ${d.actor === "owner" ? "by you" : "by the agent"}`}
          {d.paid_via ? ` · ${d.paid_via}` : ""}
          {d.tx ? (
            <>
              {" · "}
              <a href={txUrl(d.tx, explorer)} target="_blank" rel="noreferrer">
                <Ed x="on chain" p="on the blockchain" />
              </a>
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function BudgetRow({ b }: { b: SpendBudget }) {
  if (!b.configured) {
    /* TWO DIFFERENT FACTS, AND THEY USED TO LOOK THE SAME. "Nobody has set a
       limit" is a thing the owner can fix in a minute. "There is no contract at
       this address on the chain we are reading" means every figure on this page
       about that wallet is unfounded, and a payment sent there would move
       nothing while recording that it had. The press now says which, so the
       chip can stop guessing. */
    return (
      <tr>
        <td className="mono">{b.category}</td>
        <td colSpan={3} className="wrap wrap-left">
          <span className={`chip ${b.reason ? "chip-breach" : "chip-gold"}`}>
            {b.reason ? (
              <Ed x="wallet not on this chain" p="this wallet is not where we are looking" />
            ) : (
              <Ed x="no budget set on chain" p="nobody has set a limit for this yet" />
            )}
          </span>
          {b.reason ? <p className="standfirst">{b.reason}</p> : null}
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
  // A statement from a press that predates the cash block has no `liquidity` at
  // all, and the connection ladder will serve exactly that from an archived
  // bundle. Absent is not zero here either, so the fallback wears the same "not
  // measured" shape the press emits rather than rendering an empty wallet.
  const liq: SpendLiquidity = st.liquidity ?? {
    held_usdc: null,
    due_usdc: 0,
    due_count: 0,
    soonest_at: null,
    undated: 0,
    horizon_days: 30,
    covers_due: null,
    reason: "this statement came from a press that does not report cash yet",
  };
  // From the BUSINESS's chain: a testnet transaction does not live on the
  // mainnet explorer, and a link to the wrong one is worse than no link.
  const explorer =
    st.business.chain === "mainnet" ? CHAIN.explorer : CHAIN_TESTNET.explorer;

  return (
    <>
      {st.business.sandbox ? (
        <section className="section">
          <div className="panel panel-pad">
            <p className="standfirst">
              <span className="chip chip-gold">
                <Ed x="sandbox" p="demo only" />
              </span>
              {" "}
              <Ed
                x="A demonstration, so the queue, the meter and the counterparty check can be seen working. Hand-written decisions, and excluded from every number on the traction page."
                p="A demo, so you can see how it works. Made-up decisions, and left out of every real count."
              />
            </p>
          </div>
        </section>
      ) : null}

      {/* ZERO IS A RESULT, which is this file's own rule three sections up and
          the one place it was not followed. The section used to disappear
          entirely at zero, so a reader could not tell "nothing is waiting" from
          "this page has no queue" — and an empty queue is the single best thing
          this product can report. */}
      {st.escalations.length === 0 && (
        <section className="section">
          <div className="section-head">
            <h2>
              <Ed x="Waiting on you" p="Waiting for you" />
            </h2>
            <span className="label">0</span>
          </div>
          <div className="panel panel-pad">
            <p className="standfirst">
              <Ed
                x="Nothing is waiting. Every obligation in this period was settled under the budget the owner set, or refused with a reason."
                p="Nothing needs you right now. The agent handled everything within your limits."
              />
            </p>
          </div>
        </section>
      )}
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
              {/* WHAT THE AGENT ADVISES, on the card where the person decides.
                  `recommended_intent` is set on every escalation the ladder
                  produces, and it is the thing "how often the human agreed" is
                  measured against — so the human doing the agreeing could not
                  see what they were agreeing with. One woven line, with the
                  bill's own references beside it, rather than a second panel. */}
              <p className="label mono">
                {d.recommended_intent && INTENT[d.recommended_intent] ? (
                  <>
                    <Ed x="agent advises" p="the agent suggests" />
                    {" "}
                    <span className={`chip ${INTENT[d.recommended_intent].cls}`}>
                      <Ed
                        x={INTENT[d.recommended_intent].x}
                        p={INTENT[d.recommended_intent].p}
                      />
                    </span>
                  </>
                ) : (
                  <Ed x="no recommendation recorded" p="the agent did not suggest one" />
                )}
                {d.invoice_ref ? ` · ${d.invoice_ref}` : ""}
                {dueWords(d.due_at ?? null, d.at)
                  ? ` · ${dueWords(d.due_at ?? null, d.at)}`
                  : ""}
                {/* SEE THE BENCHMARK THIS DECISION RESTS ON, on the card where
                    the person is about to agree or refuse. `/check` prices one
                    bill against published third-party prices and shows every
                    one it used with a link — so the owner can check the rule
                    sentence above instead of taking it.

                    In this line rather than as a control of its own: the bill's
                    other references already live here, and a panel per
                    escalation would be clutter on the page that most needs to
                    be scannable.

                    OFFERED ONLY WHEN IT WOULD WORK. `/check` needs a unit, an
                    amount and a quantity, and refuses to populate from a
                    partial URL. Measured on 112 live fleet receipts: 42 are
                    `$/1k tokens`, 12 `$/GPU-sec`, 12 `$/MB`, 6 `$/query` and 40
                    carry no unit at all — and every decision now on the press
                    predates the `unit` field entirely. A link that lands on an
                    empty form is worse than no link, so this renders for the
                    priceable ones and stays absent for the rest. */}
                {checkHref(d) ? (
                  <>
                    {" · "}
                    <Link className="section-link" href={checkHref(d) as string}>
                      <Ed x="price it yourself" p="check this price" />
                    </Link>
                  </>
                ) : null}
              </p>
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
          {/* /traction had ZERO inbound links — the masthead was the only way in,
              which is exactly the property that justified folding /exchange away.
              It links OUT to /spend?business=… and nothing linked back, so the
              two siblings were a one-way street. This is the figures above for
              every business rather than this one. */}
          <a className="section-link" href="/traction">
            <Ed x="every business →" p="all the businesses →" />
          </a>
        </div>
        <p className="standfirst">
          <Ed
            x="What the agent decided on its own authority, and what it sent to a person."
            p="What the agent settled by itself, and what it passed to a person."
          />
        </p>
        <div className="panel panel-pad">
          <div className="table-scroll">
            <table className="sheet">
              <tbody>
                <tr className="sheet-group">
                  <th scope="rowgroup" colSpan={2}>
                    <Ed x="Decisions" p="What it decided" />
                  </th>
                </tr>
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
                {/* THE SPLIT THIS TABLE EXISTS TO HOLD. Everything under this
                    heading is money that really moved or really stayed, and the
                    one figure under the next heading is not — it was worked out
                    against an offer nobody took. They used to sit adjacent, on
                    the hope that a reader would see the difference rather than
                    be told it. Eight flush rows do not carry that, so the
                    distinction is a heading now instead of a seating plan. */}
                <tr className="sheet-group">
                  <th scope="rowgroup" colSpan={2}>
                    <Ed
                      x="Money, realised"
                      p="Money that really moved or really stayed"
                    />
                  </th>
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
                      x="Held back against an agreement"
                      p="Money a vendor asked for that we had not agreed to pay"
                    />
                  </td>
                  <td className="mono">{price(s.held_back_usdc)}</td>
                </tr>
                {/* The third of the three, and the only one a reader is likely
                    to have felt: a bill for seats nobody opened. `Consumption
                    discrepancies` below has always been able to say that one
                    bill disagreed with our meter — this says how much of it was
                    for something that did not happen, which is the half anybody
                    acts on. Realised, like the row above it: the money stayed. */}
                <tr>
                  <td>
                    <Ed
                      x="Overbilled against our own meter"
                      p="Money billed for things we could not find any record of using"
                    />
                  </td>
                  <td className="mono">{price(s.overbilled_usdc)}</td>
                </tr>
                {/* Alone under its own heading, because it is the one figure
                    here that never touched the wallet: it is measured against
                    another seller's OFFER, and nothing was bought. The ledger
                    refuses to book it as income for that reason, and the page
                    now refuses to seat it among the figures that did. */}
                <tr className="sheet-group">
                  <th scope="rowgroup" colSpan={2}>
                    <Ed
                      x="Measured, not realised"
                      p="Money we spotted but did not actually save"
                    />
                  </th>
                </tr>
                <tr>
                  <td>
                    <Ed
                      x="Overpay found by rerouting"
                      p="Money we could have saved by buying from somebody cheaper"
                    />
                  </td>
                  <td className="mono">{price(s.saved_usdc)}</td>
                </tr>
                <tr className="sheet-group">
                  <th scope="rowgroup" colSpan={2}>
                    <Ed
                      x="Against our own meter"
                      p="What our own count found"
                    />
                  </th>
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

      {/* CASH, AND IT HAS TO COME BEFORE THE CAPS.

          `remaining_usdc` in the table below is `cap - spent`, read from the
          contract's own counters: PERMISSION. It reads perfectly healthy on a
          wallet holding nothing, and the payment then reverts on chain. An
          owner who met the full allowance first and the empty balance second
          would have read the misleading figure first, which is the defect this
          section exists to close.

          RFB 4 opens its list of what the agent decides with "whether there is
          enough liquidity to cover what is due". This is that same question put
          back to the person the agent escalates to. */}
      <section className="section">
        <div className="section-head">
          <h2>
            <Ed x="Cash" p="Money in the wallet" />
          </h2>
          {/* Four states, and only one of them is an alarm. The chip is the
              one the escalation queue already uses, dropped into the label slot
              every other section head has — a change of weight rather than
              another element on the page. */}
          <span className="label">
            {liq.held_usdc == null ? (
              <Ed x="not measured" p="could not check" />
            ) : liq.due_count === 0 ? (
              <Ed x="nothing dated" p="nothing with a date yet" />
            ) : liq.covers_due ? (
              <Ed x="covers what is due" p="enough for what is coming" />
            ) : (
              <span className="chip chip-breach">
                <Ed x="short of what is due" p="not enough for what is coming" />
              </span>
            )}
          </span>
        </div>
        <p className="standfirst">
          <Ed
            x="What the wallet holds, against the bills waiting on you that carry a due date. A cap is permission; this is money, and the two can disagree."
            p="What is really in the wallet. The limits below are what the agent may spend; this is what there is to spend."
          />
        </p>
        <div className="panel panel-pad">
          <div className="table-scroll">
            <table className="sheet">
              <thead>
                <tr>
                  <th>
                    <Ed x="Held" p="In the wallet" />
                  </th>
                  <th>
                    <Ed
                      x={`Due in ${fmtInt(liq.horizon_days)} days`}
                      p={`Owed in ${fmtInt(liq.horizon_days)} days`}
                    />
                  </th>
                  <th>
                    <Ed x="Soonest" p="First one due" />
                  </th>
                  <th>
                    <Ed x="Not dated" p="No date given" />
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="mono">{price(liq.held_usdc)}</td>
                  <td className="mono">{price(liq.due_usdc)}</td>
                  <td className="mono">
                    {dueWords(liq.soonest_at, st.as_of) ?? price(null)}
                  </td>
                  <td className="mono">{fmtInt(liq.undated)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {/* Not "0 USDC". An unfunded wallet and an unreachable node are
              different facts, the press keeps them apart, and collapsing them
              at the last step would undo that. */}
          {liq.reason ? <p className="standfirst">{liq.reason}</p> : null}
          {liq.undated > 0 ? (
            <p className="standfirst">
              <Ed
                x={`${fmtInt(liq.undated)} of these carry no due date, so they are counted apart rather than inside the total above: not knowing when a bill is due is not the same as it being due later.`}
                p={`${fmtInt(liq.undated)} of these do not say when they are due, so they are left out of the total above rather than guessed at.`}
              />
            </p>
          ) : null}
        </div>
        <p className="standfirst">
          <Ed
            x="Not a forecast. There is no burn rate and no runway here, only what is held now against what is dated now."
            p="This is not a prediction. It is what is there now, and what is owed soon."
          />
        </p>
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
              <table className="sheet">
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
              <table className="sheet sheet-rules">
                <thead>
                  <tr>
                    <th>
                      <Ed x="Outcome" p="What happened" />
                    </th>
                    <th>
                      <Ed x="Billed" p="Asked for" />
                    </th>
                    <th>
                      <Ed x="Metered / billed" p="We counted / they said" />
                    </th>
                    <th>
                      <Ed x="Par" p="Going rate" />
                    </th>
                    <th>
                      <Ed x="Counterparty" p="Checked?" />
                    </th>
                    <th>
                      <Ed x="Rule" p="Why" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {st.recent.map((d) => (
                    <DecisionRow
                      key={`${d.obligation_id}-${d.at}`}
                      d={d}
                      explorer={explorer}
                    />
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
              <table className="sheet">
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
            {/* WHICH failure, not just that there was one. `statement.py`
                distinguishes four: the lookup exceeded its budget (SLOW), it
                raised (UNAVAILABLE), nobody asked for it, or this treasury has
                no indexed history. All four used to print the last sentence,
                which told an owner their wallet has no history when in fact a
                subgraph read had timed out — and a 7s read against a 5s budget
                is precisely the bug that once made a working statement look
                broken. The decision rows above never depend on this block, so
                saying so is the useful half of the message. */}
            <p className="standfirst">
              {ctx.reason === "SLOW" ? (
                <Ed
                  x="The comparison took longer than its budget, so the statement came without it. Every decision above is unaffected."
                  p="The price comparison was too slow to wait for. The decisions above are not affected."
                />
              ) : ctx.reason === "UNAVAILABLE" ? (
                <Ed
                  x="The comparison could not be read this time. Every decision above is unaffected, and a reload may carry it."
                  p="We could not load the price comparison this time. The decisions above are not affected."
                />
              ) : ctx.reason === "not requested" ? (
                <Ed
                  x="Not requested for this statement."
                  p="We did not ask for the price comparison here."
                />
              ) : (
                <Ed
                  x="No indexed history for this treasury yet."
                  p="We have no published history for this wallet yet."
                />
              )}
            </p>
          </div>
        )}
      </section>
    </>
  );
}

/** `initial` comes from `?business=` on the page, already validated there.
 *  It seeds the choice and nothing more: once a reader presses a button the
 *  local state owns it, so the selector keeps working on a deep-linked page. */
export function SpendView({ initial = null }: { initial?: string | null }) {
  const nowS = useNow();
  const { businesses, error: listError } = useBusinesses();
  const rows = businesses?.data?.businesses ?? [];
  const [chosen, setChosen] = useState<string | null>(initial);
  // The deep link is honoured immediately — waiting for the business list to
  // arrive would flash the wrong business first — but not past the point where
  // the registry can contradict it. A well-formed slug nobody has onboarded
  // would otherwise fetch a statement for nobody, and this page renders that
  // as "the press did not answer", which blames the service for a bad link.
  const strayLink =
    chosen !== null && rows.length > 0 && !rows.some((b) => b.slug === chosen);
  const slug = (strayLink ? null : chosen) ?? rows[0]?.slug ?? null;
  // THIRTY DAYS, not the hook's 7-day default, and the number is load-bearing.
  // `acr-fleet`'s only activity leaves a 7-day window after 2026-10-10T06:54Z
  // and the sandbox's after 2026-10-09T00:03:20Z — so this page was days away
  // from showing a correctly-fetched, live, EMPTY statement for a business that
  // has spent money, which is the same falsehood the list above was telling by
  // a different route. A window is a question, and 7 days was asking the wrong
  // one. Inside the proxy's 1..90 clamp, so it cannot become a slow query.
  const { statement, error: stError, refresh } = useStatement(slug, 30);
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

        {/* THIS BRANCH WAS UNREACHABLE CODE until 2026-10-07, and the one below
            it ran in its place. `lib/useLive.ts`'s fetcher throws only on a
            non-ok STATUS, and `app/api/operator/businesses/route.ts` answered
            200 with `data: null` whenever the press was unreachable — so a
            reviewer opening this page against a press with no operator routes
            was told "No businesses onboarded yet" about a product that has one.
            The copy here was right all along. Nothing could reach it. The proxy
            now refuses with 503 and this fires.

            `&& rows.length === 0`, not `listError` alone: SWR keeps the last
            good payload when a revalidation fails, and a transient 503 after a
            successful load should not replace a real business with an apology.
            The staleness is already legible in the age label in the section
            head above, which keeps counting up off the retained `fetchedAt` —
            woven into an element that exists rather than added as a banner. */}
        {listError && rows.length === 0 ? (
          <div className="panel panel-pad">
            <p className="standfirst">
              <Ed
                x="The press did not answer, so this page is showing nothing rather than something stale."
                p="We could not reach the service, so this shows nothing rather than old news."
              />
            </p>
          </div>
        ) : businesses?.data == null ? (
          /* NOTHING, because we have not asked yet.
             Measured on production right after the 503 fix shipped: for about a
             second between first paint and the answer arriving, this page said
             "No businesses onboarded yet" — the zero state wearing the loading
             state's clothes. It is the same defect the 503 fixed, one layer up:
             `rows` is `[]` before the request resolves exactly as it is when the
             answer is genuinely empty, so a branch keyed on `rows.length` cannot
             tell them apart and asserts the stronger claim.
             `businesses?.data` is the thing that distinguishes them. Brief is
             not harmless: a reviewer's first paint is the one they screenshot. */
          null
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
              <table className="sheet">
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
                        {/* Said wherever the business appears, so nobody can
                            mistake a demonstration for a customer. */}
                        {b.sandbox ? (
                          <span className="chip chip-gold">
                            <Ed x="sandbox" p="demo only" />
                          </span>
                        ) : null}
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
      <LedgerAuditSection slug={slug} />
    </>
  );
}

/* What each of the six is called, and what it is in plain words.

   The expert names are the essay's own, because a reader who has read it should
   recognise them on sight and a reader who has not should be able to search for
   them. The plain column is what the error actually does to your money. */
const AUDIT_WORDS: Record<string, [string, string]> = {
  omission: ["omission", "a payment nobody wrote down"],
  commission: ["commission", "the money went to the wrong party"],
  principle: ["principle", "booked under the wrong heading"],
  "original entry": ["original entry", "the wrong amount, or paid twice"],
  compensating: ["compensating", "two errors that cancel each other out"],
  "complete reversal": ["complete reversal", "booked backwards"],
  // Not one of the essay's six, and the row that carries this page's headline
  // claim. Without an entry here it fell through to the raw string and printed
  // "phantom payment" in the plain edition too — the one row a plain reader
  // most needs words for.
  "phantom payment": ["phantom payment", "a payment that never happened"],
};

/** The six errors a balanced ledger cannot see, and what the search found.
 *
 *  This sits LAST on purpose. Everything above it is the agent reporting its
 *  own work; this is the only block that reports on that report, and a reader
 *  has to have seen the decisions before "we checked them" means anything.
 *
 *  `searched` is rendered beside every `found`, because a check that looked at
 *  nothing and found nothing reads exactly like a clean book. */
function LedgerAuditSection({ slug }: { slug: string | null }) {
  const { ledgerAudit } = useLedgerAudit(slug);
  const a: LedgerAudit | null = ledgerAudit?.data ?? null;
  if (!a) return null;

  return (
    <section className="section">
      <div className="section-head">
        <h2>
          <Ed x="What the ledger cannot check" p="What adding up cannot catch" />
        </h2>
        <span className="label">{a.clean ? "no findings" : `${a.findings.length}`}</span>
      </div>
      <p className="standfirst standfirst-block">
        <Ed
          x="Every transaction in the beancount export sums to zero. So would a payment to the wrong vendor, in the wrong account, for the wrong amount, or booked backwards. These six are searched for outside the ledger, because inside it they all balance."
          p="The books add up. So would paying the wrong person, or paying twice. These six checks look for the mistakes that still add up."
        />
      </p>
      <div className="panel panel-pad">
        <div className="table-scroll">
          <table className="sheet">
            <tbody>
              {a.checks.map((c) => {
                const [x, pl] = AUDIT_WORDS[c.error] ?? [c.error, c.error];
                return (
                  <tr key={c.error}>
                    <td>
                      <Ed x={x} p={pl} />
                    </td>
                    <td className="mono">
                      {c.found > 0 ? (
                        <span className="chip chip-breach">{fmtInt(c.found)}</span>
                      ) : (
                        <span className="chip chip-teal">
                          <Ed x="none" p="none" />
                        </span>
                      )}
                    </td>
                    {/* The denominator, always. "found 0 of 0 searched" is not
                        a clean book, and without this column it looks like one. */}
                    <td className="mono">
                      <Ed
                        x={`${fmtInt(c.searched)} checked`}
                        p={`${fmtInt(c.searched)} looked at`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {a.findings.length > 0 ? (
          <ul className="findings">
            {a.findings.map((f, i) => (
              <li key={`${f.error}-${f.obligation_id}-${i}`}>
                <span className="label">{f.error}</span> {f.detail}
              </li>
            ))}
          </ul>
        ) : null}
        {a.unattributable_settlements > 0 ? (
          /* Never folded into "clean". A settlement with no payee cannot be
             matched to any decision, so it is neither covered nor a finding —
             and calling it covered would be the omission this exists to find. */
          <p className="standfirst">
            <Ed
              x={`${fmtInt(a.unattributable_settlements)} settlement(s) name no payee, so no decision can be matched to them either way.`}
              p={`${fmtInt(a.unattributable_settlements)} payments do not say who was paid, so they cannot be checked.`}
            />
          </p>
        ) : null}
      </div>
    </section>
  );
}
