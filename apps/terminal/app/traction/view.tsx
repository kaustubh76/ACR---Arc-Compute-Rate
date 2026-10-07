"use client";

import Link from "next/link";

import { Ed } from "@/components/Ed";
import { ageWords, fmtInt, fmtPrice } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { useTraction } from "@/lib/useLive";
import type { TractionPayload, TractionRow } from "@/lib/types";

/* The traction page — every figure computed from the rows that justify it.

   THE DISTINCTION THIS PAGE EXISTS TO HOLD. `moved` is what the operator paid
   out. `priced` is what it assessed: metered, benchmarked, decided on. They are
   different claims, and on this project today the first is zero and the second
   is not, because no wallet is funded yet. Showing one number for both would be
   the most tempting lie available on a traction page, so the two sit side by
   side with their own labels.

   MAINNET AND TESTNET ARE NEVER SUMMED. Canteen say test USDC counts and
   mainnet counts more, which only means anything if the two are reported apart.
   There is no total row anywhere on this page.

   AND EVERY ROW LINKS TO ITS OWN LEDGER. A number a reader cannot open is a
   claim; a number beside the double-entry file it came from is evidence. */

function price(n: number | null | undefined): string {
  return fmtPrice(typeof n === "number" ? n : NaN);
}

/** How a business arrived. Reported apart because the evidence differs: our own
 *  company is not a studio we have never met. Keys match `businesses.TIERS`. */
const TIERS: Array<[key: string, x: string, p: string]> = [
  ["own", "Our own", "Ours"],
  ["network", "From our network", "People we know"],
  ["cohort", "Another team in the cohort", "Another team here"],
  ["oss", "An open-source project", "An open project"],
];

/** Every outcome the agent reaches. Holding and refusing are decisions, not
 *  failures, so they are counted beside the payments. */
const INTENTS: Array<[key: string, x: string, p: string]> = [
  ["pay", "Paid or cleared to pay", "Paid, or allowed"],
  ["reroute", "Rerouted to a cheaper seller", "Bought cheaper elsewhere"],
  ["hold", "Held on purpose", "Waiting on purpose"],
  ["escalate", "Sent to a person", "Passed to a person"],
  ["refuse", "Refused outright", "Turned down"],
];

/** `n of m`, and the honest thing when `m` is zero.
 *
 *  Every figure in the block above has a denominator that can be zero: nobody
 *  has resolved an escalation yet, no obligation carries a due date yet. A rate
 *  over zero prints 100% or 0% with equal confidence and no information, and
 *  those are the two most flattering numbers available on a traction page. */
function Of({ n, of }: { n: number; of: number }) {
  if (of <= 0) {
    return (
      <span className="label">
        <Ed x="none yet" p="none yet" />
      </span>
    );
  }
  return (
    <>
      {fmtInt(n)}
      <span className="label"> / {fmtInt(of)}</span>
    </>
  );
}

function BusinessRow({ r }: { r: TractionRow }) {
  return (
    <tr>
      <td>{r.label}</td>
      <td className="mono">{r.chain}</td>
      <td className="mono">{r.tier}</td>
      <td className="mono">{fmtInt(r.decisions)}</td>
      <td className="mono">{price(r.moved_usdc)}</td>
      <td className="mono">{price(r.received_usdc)}</td>
      <td className="mono">{price(r.priced_usdc)}</td>
      <td className="mono">{price(r.recoverable_usdc)}</td>
      <td className="mono">{fmtInt(r.discrepancies)}</td>
      {/* PER BUSINESS, not just in the aggregate. RFB 4 asks "obligations
          settled without a human touching them", and WHICH business needed one
          is the half a total cannot answer: one owner clearing ten escalations
          and ten owners clearing one each are the same number and not the same
          product. */}
      <td className="mono">{fmtInt(r.settled_by_agent)}</td>
      <td className="mono">
        {fmtInt(r.settled_by_owner)}
        {r.owner_resolutions > 0 ? (
          <span className="label">
            {" "}
            {fmtInt(r.owner_agreed)}/{fmtInt(r.owner_resolutions)}{" "}
            <Ed x="agreed" p="agreed" />
          </span>
        ) : null}
      </td>
      <td className="mono">
        {fmtInt(r.risk_events_caught)}
        {/* Never folded into the number beside it. "We could not check" filed
            under "we caught something" inverts the only claim it makes. */}
        {r.paid_unscreened > 0 ? (
          <span className="label">
            {" "}
            {fmtInt(r.paid_unscreened)} <Ed x="unscreened" p="not checked" />
          </span>
        ) : null}
      </td>
      <td>
        <span className={`chip ${r.spends ? "chip-teal" : "chip-sky"}`}>
          {r.spends ? (
            <Ed x="can pay" p="can pay" />
          ) : (
            <Ed x="measured only" p="watching only" />
          )}
        </span>
      </td>
      <td>
        {/* Both links, because a figure a reader cannot open is a claim. The
            statement was emitted and unreachable from this page.

            Built from the slug, NOT from `r.statement`/`r.ledger`. Those are
            the press's own paths (`/operator/...`), and they are correct for
            the press — but they are relative, so on this origin they resolved
            against the terminal and landed on the 404 page. The terminal links
            into its own space: a page for the statement, its proxy for the
            file. tests/test_render_parity.py carries the exemption. */}
        <Link className="section-link" href={`/spend?business=${encodeURIComponent(r.slug)}`}>
          <Ed x="statement" p="the summary" />
        </Link>
        {" · "}
        {/* `download`, because beancount is a file format with tools that read
            it — bean-check on a saved file, not a tab of plain text. */}
        <a
          className="section-link"
          href={`/api/operator/ledger?business=${encodeURIComponent(r.slug)}`}
          download={`${r.slug}.beancount`}
        >
          <Ed x="ledger" p="the file" />
        </a>
      </td>
    </tr>
  );
}

function Numbers({ t }: { t: TractionPayload }) {
  const chains = Object.entries(t.by_chain);
  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2>
            <Ed x="Businesses" p="Businesses" />
          </h2>
          <span className="label">{fmtInt(t.businesses.businesses)}</span>
        </div>
        <p className="standfirst">
          <Ed
            x="Counted from the registry, not from a tally kept beside it."
            p="Counted from the list itself, so the number cannot drift."
          />
        </p>
        <div className="panel panel-pad">
          <div className="table-scroll">
            <table className="sheet">
              <tbody>
                <tr>
                  <td>
                    <Ed x="Onboarded" p="Using it" />
                  </td>
                  <td className="mono">{fmtInt(t.businesses.businesses)}</td>
                </tr>
                <tr>
                  <td>
                    <Ed x="Named with consent" p="Happy to be named" />
                  </td>
                  <td className="mono">{fmtInt(t.businesses.consented)}</td>
                </tr>
                <tr>
                  <td>
                    <Ed x="With a funded wallet" p="The agent can pay for them" />
                  </td>
                  <td className="mono">{fmtInt(t.businesses.spending)}</td>
                </tr>
                {/* "Our own company" and "a studio we have never met" are not the
                    same evidence, and one number would hide which is which.
                    These four sum to `Onboarded` above, so they are a breakdown
                    of it and not four more entries beside it — which is all the
                    heading and the rail are there to say. */}
                <tr className="sheet-group">
                  <th scope="rowgroup" colSpan={2}>
                    <Ed x="How they arrived" p="How we met them" />
                  </th>
                </tr>
                {TIERS.map(([key, x, pl]) => (
                  <tr className="sheet-sub" key={key}>
                    <td>
                      <Ed x={x} p={pl} />
                    </td>
                    <td className="mono">
                      {fmtInt(t.businesses.by_tier[key] ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="standfirst">
            <Ed
              x="A business that has not agreed to be named still counts, under a pseudonym. Dropping it would understate real usage."
              p="A business that does not want naming still counts, with its name hidden."
            />
          </p>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>
            <Ed x="What it moved" p="Money" />
          </h2>
          <span className="label">
            <Ed x="per chain" p="per network" />
          </span>
        </div>
        <p className="standfirst standfirst-block">
          <Ed
            x="Moved is what the agent paid out. Priced is what it assessed: metered, checked against the market, decided on. They are different claims and this page keeps them apart."
            p="Moved is what it actually paid. Priced is what it checked over. Those are not the same thing."
          />
        </p>
        <div className="panel panel-pad">
          <div className="table-scroll">
            <table className="sheet">
              <thead>
                <tr>
                  <th>
                    <Ed x="Chain" p="Network" />
                  </th>
                  <th>
                    <Ed x="Moved" p="Paid out" />
                  </th>
                  {/* Beside what went out, never netted against it. A business
                      that received 10 and paid 10 did twice the work of one
                      that did neither, and one net figure reports both as 0. */}
                  <th>
                    <Ed x="Received" p="Taken in" />
                  </th>
                  <th>
                    <Ed x="Priced" p="Checked over" />
                  </th>
                  <th>
                    <Ed x="Recoverable found" p="Overpay found" />
                  </th>
                  {/* The two REALISED figures, and they were computed on every
                      request and then dropped — so this table totalled the
                      hypothetical column and showed neither of the two a bank
                      statement would corroborate. Money a vendor asked for
                      that did not leave the wallet, kept in separate columns
                      because one is "we had not agreed to this" and the other
                      is "our own meter disagrees", and never added together. */}
                  <th>
                    <Ed x="Held back" p="Not paid, by agreement" />
                  </th>
                  <th>
                    <Ed x="Overbilled" p="Not paid, by our count" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {chains.map(([chain, v]) => (
                  <tr key={chain}>
                    <td className="mono">{chain}</td>
                    <td className="mono">{price(v.moved_usdc)}</td>
                    <td className="mono">{price(v.received_usdc)}</td>
                    <td className="mono">{price(v.priced_usdc)}</td>
                    <td className="mono">{price(v.recoverable_usdc)}</td>
                    <td className="mono">{price(v.held_back_usdc)}</td>
                    <td className="mono">{price(v.overbilled_usdc)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* The caveat comes from the PAYLOAD, not from prose typed here. It
              was written in both places, which is two sources for one claim and
              the slower one goes stale. */}
          <p className="standfirst">
            <Ed
              x={t.note}
              p="The networks are never added up, and checked is not the same as paid."
            />
          </p>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>
            <Ed x="What it caught" p="What it found" />
          </h2>
          <span className="label">{fmtInt(t.work.decisions)}</span>
        </div>
        <div className="panel panel-pad">
          <div className="table-scroll">
            <table className="sheet">
              <tbody>
                <tr>
                  <td>
                    <Ed x="Decided on its own authority" p="Handled by itself" />
                  </td>
                  <td className="mono">{fmtInt(t.work.decided)}</td>
                </tr>
                <tr>
                  <td>
                    <Ed x="Sent to a person" p="Passed to a person" />
                  </td>
                  <td className="mono">{fmtInt(t.work.escalated)}</td>
                </tr>
                {/* All five, because holding and refusing are decisions the
                    agent made, not absences. */}
                {INTENTS.map(([key, x, pl]) => (
                  <tr key={key}>
                    <td>
                      <Ed x={x} p={pl} />
                    </td>
                    <td className="mono">{fmtInt(t.work.by_intent[key] ?? 0)}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <Ed x="Bills for more than we counted" p="Bills for more than we used" />
                  </td>
                  <td className="mono">{fmtInt(t.work.consumption_discrepancies)}</td>
                </tr>
                <tr>
                  <td>
                    <Ed x="Bills we held no record for" p="Bills we had no record of" />
                  </td>
                  <td className="mono">{fmtInt(t.work.unmetered)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* THE THREE FIGURES THE BRIEFS NAME BY WORD, each as a pair of counts.

          "Obligations settled on time without a human touching them" and
          "decisions made vs escalated, and how often the human agreed" are
          RFB 4's own wording; "risk events caught before the transaction" is
          RFB 5's. None of them was answerable until the record said who acted
          and what the agent would have done.

          NO PERCENTAGES. Each of these is N of M, because every one of them has
          a denominator that can be zero, and a rate over zero prints 100% or
          0% with equal confidence and equal meaninglessness. */}
      <section className="section">
        <div className="section-head">
          <h2>
            <Ed x="Without a person in the room" p="What it did on its own" />
          </h2>
        </div>
        <p className="standfirst">
          <Ed
            x="Counted apart since the record started saying who acted. An owner's approval used to be written as an ordinary payment, so every one of these figures would have read as the agent's own work."
            p="We count what the agent did alone apart from what a person approved. Before, the two looked the same."
          />
        </p>
        <div className="panel panel-pad">
          <div className="table-scroll">
            <table className="sheet">
              <tbody>
                <tr>
                  <td>
                    <Ed x="Settled by the agent alone" p="Finished by the agent alone" />
                  </td>
                  <td className="mono">{fmtInt(t.work.autonomy.settled_by_agent)}</td>
                </tr>
                <tr>
                  <td>
                    <Ed x="Settled by its owner" p="Finished by a person" />
                  </td>
                  <td className="mono">{fmtInt(t.work.autonomy.settled_by_owner)}</td>
                </tr>
                <tr>
                  <td>
                    <Ed x="Settled on time" p="Paid by the date due" />
                  </td>
                  {/* Against its OWN denominator. A bill with no due date cannot
                      be late, and counting it punctual would turn "we do not
                      know when this was due" into evidence of promptness. */}
                  <td className="mono">
                    <Of n={t.work.autonomy.settled_on_time} of={t.work.autonomy.settled_with_a_due_date} />
                  </td>
                </tr>
                <tr>
                  <td>
                    <Ed x="The owner agreed with the agent" p="The person agreed with the agent" />
                  </td>
                  <td className="mono">
                    <Of n={t.work.agreement.owner_agreed} of={t.work.agreement.owner_resolutions} />
                  </td>
                </tr>
                <tr>
                  <td>
                    <Ed x="Risk caught before the payment" p="Risky payees stopped before paying" />
                  </td>
                  <td className="mono">{fmtInt(t.work.screening.risk_events_caught)}</td>
                </tr>
                <tr>
                  <td>
                    {/* Never folded into the line above. "We could not check"
                        filed under "we caught something" inverts the claim. */}
                    <Ed x="Paid without a screen answering" p="Paid when the check could not answer" />
                  </td>
                  <td className="mono">{fmtInt(t.work.screening.paid_unscreened)}</td>
                </tr>
                {/* SCREENED, not monitored. The brief asks for "addresses
                    monitored"; this agent screens once, inside the decision,
                    and nothing re-screens on a schedule. Reporting the word the
                    brief used would claim a capability we do not have. */}
                <tr>
                  <td>
                    <Ed x="Counterparties screened" p="Payees we checked" />
                  </td>
                  <td className="mono">{fmtInt(t.work.compliance.addresses_screened)}</td>
                </tr>
                <tr>
                  <td>
                    <Ed x="Alerts raised, and settled" p="Warnings raised, and dealt with" />
                  </td>
                  <td className="mono">
                    <Of
                      n={t.work.compliance.alerts_resolved}
                      of={t.work.compliance.alerts_raised}
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>
            <Ed x="Per business" p="One by one" />
          </h2>
        </div>
        <p className="standfirst">
          <Ed
            x="Each row opens its own double-entry ledger, so the arithmetic is checkable rather than asserted."
            p="Each row opens its own file, so you can check the sums yourself."
          />
        </p>
        <div className="panel panel-pad">
          <div className="table-scroll">
            <table className="sheet sheet-wide">
              <thead>
                <tr>
                  <th>
                    <Ed x="Business" p="Business" />
                  </th>
                  <th>
                    <Ed x="Chain" p="Network" />
                  </th>
                  <th>
                    <Ed x="How it arrived" p="How we met" />
                  </th>
                  <th>
                    <Ed x="Decisions" p="Decisions" />
                  </th>
                  <th>
                    <Ed x="Moved" p="Paid" />
                  </th>
                  <th>
                    <Ed x="Received" p="Taken in" />
                  </th>
                  <th>
                    <Ed x="Priced" p="Checked" />
                  </th>
                  <th>
                    <Ed x="Found" p="Found" />
                  </th>
                  <th>
                    <Ed x="Overbilled" p="Billed too much" />
                  </th>
                  <th>
                    <Ed x="Settled alone" p="Done by itself" />
                  </th>
                  <th>
                    <Ed x="Needed you" p="Needed a person" />
                  </th>
                  <th>
                    <Ed x="Risk caught" p="Risky payees stopped" />
                  </th>
                  <th>
                    <Ed x="Spending" p="Can it pay?" />
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {t.per_business.map((r) => (
                  <BusinessRow key={r.slug} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}

export function TractionView() {
  const nowS = useNow();
  const { traction, error } = useTraction();
  const t = traction?.data ?? null;

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2>
            <Ed x="Traction" p="Who is using it" />
          </h2>
          {traction?.fetchedAt && nowS > 0 ? (
            <span className="label">
              {ageWords(Math.max(0, nowS - Math.round(traction.fetchedAt / 1000)))}
            </span>
          ) : null}
        </div>
        <p className="standfirst standfirst-block">
          <Ed
            x="Every figure here is counted from the registry and the decision log when you load the page. Nothing on it is maintained by hand, so no number can drift from the rows beside it."
            p="Every number here is counted fresh from the records, so none of them can drift."
          />
        </p>
        {/* THIS PAGE RENDERED NOTHING AT ALL, and that is a different symptom
            from /spend's for the same cause. `app/api/operator/traction/route.ts`
            answered 200 with `data: null` when the press was unreachable, so
            `error` stayed falsy while `t` stayed null — and every branch here
            needs a non-null payload. The result was a heading, a standfirst,
            and a blank space where the figures go. Not a false number: no
            number, with nothing saying why. The proxy now refuses with 503 and
            this branch fires.

            `&& !t`, not `error` alone: SWR keeps the last good payload across a
            failed revalidation, and `Numbers` below renders off that same `t`.
            Without the guard a transient 503 would print an apology directly
            above the figures it apologises for. */}
        {error && !t ? (
          <div className="panel panel-pad">
            <p className="standfirst">
              <Ed
                x="The press did not answer, so this page shows nothing rather than a count from a service that is not running."
                p="We could not reach the service, so this shows nothing rather than old numbers."
              />
            </p>
          </div>
        ) : t && t.businesses.businesses === 0 ? (
          <div className="panel panel-pad">
            <p className="standfirst">
              <Ed
                x="No businesses onboarded yet. Zero is the honest answer, and it is the number we are working on."
                p="No businesses yet. Zero is the true answer, and the one we are working on."
              />
            </p>
          </div>
        ) : null}
      </section>

      {t && t.businesses.businesses > 0 ? <Numbers t={t} /> : null}
    </>
  );
}
