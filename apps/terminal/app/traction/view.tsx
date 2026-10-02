"use client";

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

function BusinessRow({ r }: { r: TractionRow }) {
  return (
    <tr>
      <td>{r.label}</td>
      <td className="mono">{r.chain}</td>
      <td className="mono">{r.tier}</td>
      <td className="mono">{fmtInt(r.decisions)}</td>
      <td className="mono">{price(r.moved_usdc)}</td>
      <td className="mono">{price(r.priced_usdc)}</td>
      <td className="mono">{price(r.recoverable_usdc)}</td>
      <td className="mono">{fmtInt(r.discrepancies)}</td>
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
            statement was emitted and unreachable from this page. */}
        <a className="section-link" href={r.statement}>
          <Ed x="statement" p="the summary" />
        </a>
        {" · "}
        <a className="section-link" href={r.ledger}>
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
            <table>
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
                    same evidence, and one number would hide which is which. */}
                {TIERS.map(([key, x, pl]) => (
                  <tr key={key}>
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
            <table>
              <thead>
                <tr>
                  <th>
                    <Ed x="Chain" p="Network" />
                  </th>
                  <th>
                    <Ed x="Moved" p="Paid out" />
                  </th>
                  <th>
                    <Ed x="Priced" p="Checked over" />
                  </th>
                  <th>
                    <Ed x="Recoverable found" p="Overpay found" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {chains.map(([chain, v]) => (
                  <tr key={chain}>
                    <td className="mono">{chain}</td>
                    <td className="mono">{price(v.moved_usdc)}</td>
                    <td className="mono">{price(v.priced_usdc)}</td>
                    <td className="mono">{price(v.recoverable_usdc)}</td>
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
            <table>
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
            <table>
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
                    <Ed x="Priced" p="Checked" />
                  </th>
                  <th>
                    <Ed x="Found" p="Found" />
                  </th>
                  <th>
                    <Ed x="Overbilled" p="Billed too much" />
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
        {error ? (
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
