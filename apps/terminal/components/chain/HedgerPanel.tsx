"use client";

/* The autonomous hedger: the only agent here that makes an economic decision.
 *
 * Every other machine on this site does one leg. The buyer pays for data it
 * never uses; the heartbeat trades without paying for what it trades on. This
 * one buys the index and then acts on what it read, from a Circle agent wallet
 * that holds no exportable key.
 *
 * Two addresses, one agent (docs/WALLETS.md): the smart account is what the
 * venue records as the taker, and its backing EOA is what the settlement
 * records as the payer. Both are shown, because a reader checking the explorer
 * would otherwise find two strangers and no explanation.
 *
 * Nulls render as "…", never as 0. An unread balance and an empty one call for
 * opposite conclusions, and this panel refuses to collapse them.
 *
 * ONE object, not a loose column. This used to be a bare <section> carrying its
 * own `.section-head` directly beneath ANOTHER `.section-head` in the page —
 * two hairlines and two gold accent bars, 56px apart, for one subject — while
 * its own two-address sub-part sat inside a `.panel`, so the part had a card
 * and the whole did not. It IS the card now, and app/exchange/view.tsx gives it
 * a bare `.section` wrapper exactly as it already does for WalletPanel.
 *
 * Built from the house vocabulary rather than its own: `.lab-counters` for the
 * headline figures (the shape /sellers uses inside a panel), `.provenance-row`
 * for the identities, `table.sheet` for the fills. Three classes this file used
 * to name exist in NO stylesheet: `table` (the original "column looks out of
 * place"), and `teal`, which meant every BUY row rendered at the inherited body
 * colour while its SELL neighbour rendered vermilion — an asymmetric pair that
 * looked like a styling bug because it was one. The house buy/sell pair is
 * green/vermilion and the futures tape has always used it. */

import type { HedgerState } from "@/lib/types";
import { formatQty, tapeAge } from "@/lib/futuresBook";
import { useNow } from "@/lib/useNow";
import { Ed } from "@/components/Ed";
import { AddressChip } from "@/components/chain/AddressChip";
import { TxLink } from "@/components/chain/TxLink";

/** The press keeps ten fills; a card shows five and says when it is hiding some. */
const SHOWN = 5;

function num(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined ? "…" : v.toFixed(digits);
}

/** The right-hand cell of a provenance row, when it carries a chip AND a
 *  trailing qualifier.
 *
 *  `.provenance-row .val` is plain inline text, but `.addr-chip` is an
 *  inline-flex box with `align-items: center`, so its baseline is not the text
 *  baseline beside it: measured, the trailing span sat 2.7px BELOW the address
 *  it annotated, at 12.5px against the chip's 12px. Two sizes on two baselines
 *  inside one cell is the "shifted by a space" effect at close range. Making
 *  the cell itself a centred flex row puts chip and qualifier on one optical
 *  line; wrapping keeps it honest on a phone, where `.label` cannot shrink. */
function Val({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="val"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        flexWrap: "wrap",
        gap: 8,
      }}
    >
      {children}
    </span>
  );
}

/** A trailing qualifier beside an address chip, matched to the chip's own size
 *  so the pair reads as one object rather than two. */
function Qual({ children }: { children: React.ReactNode }) {
  return (
    <span className="muted mono" style={{ fontSize: 12 }}>
      {children}
    </span>
  );
}

/** The card and its one head. Both states use it, so a deployment with no
 *  hedger reads as the same object switched off rather than as some other
 *  component. Local to this file on purpose: lib/coverage.test.ts ledgers every
 *  .tsx under app/ and components/ in BOTH directions, so extracting this would
 *  need a ledger entry to avoid failing CI. */
function Card({
  indexId,
  chip,
  children,
}: {
  indexId?: string | null;
  chip: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="panel panel-pad">
      <div className="section-head" style={{ marginTop: 0 }}>
        <span className="label">
          <Ed x="autonomous hedger" p="the robot that hedges its own bill" />
          {indexId ? <span className="muted"> · {indexId}</span> : null}
        </span>
        {chip}
      </div>
      {children}
    </div>
  );
}

export function HedgerPanel({
  state,
  live,
  explorer,
}: {
  state: HedgerState | null;
  live: boolean;
  explorer?: string;
}) {
  const nowS = useNow();

  /* The offline/unconfigured state. lib/fallback.json carries `configured:
     false` and omits `gap_contracts` entirely, so this branch must never read
     the standings — but it does know the index, the mandate and the venue, and
     a state that shows what the agent WOULD do teaches more than a sentence
     apologising for its absence. `state` itself is null on SWR's first render,
     so every field is optional-chained. */
  if (!state?.configured) {
    return (
      <Card
        indexId={state?.index_id}
        chip={
          <span className="chip chip-sim">
            <Ed x="not configured" p="switched off here" />
          </span>
        }
      >
        <p className="muted" style={{ fontSize: 13, margin: "0 0 18px", maxWidth: 68 * 9 }}>
          <Ed
            x="No hedger agent is configured on this deployment. Set ACR_HEDGER_ADDRESS to the Circle agent wallet; the mandate it would take is below."
            p="No robot trader is switched on here, but the job it would be given is written below."
          />
        </p>

        <div className="provenance">
          <div className="provenance-row">
            <span className="label">
              <Ed x="mandate · contracts" p="the goal · contracts" />
            </span>
            <span className="val">{num(state?.target_contracts)}</span>
          </div>
          <div className="provenance-row">
            <span className="label">
              <Ed x="venue · series" p="where it would trade · round" />
            </span>
            <Val>
              {state?.venue ? (
                <AddressChip address={state.venue} explorer={explorer} copy={false} />
              ) : (
                "…"
              )}
              <Qual>#{state?.series_id ?? "…"}</Qual>
            </Val>
          </div>
        </div>
      </Card>
    );
  }

  const { position_contracts: pos, target_contracts: target, gap_contracts: gap } = state;

  /* The gap is a VERDICT when it is zero and a QUANTITY when it is not, so it
     gets a chip rather than a tile of its own: a tile reading 0.00 beside 2.00
     and 2.00 was three equal-weight figures asserting one fact. The press
     derives gap as mandate minus position (services/index_api/index_api/
     hedger.py), so it is never re-derived here — the UI would drift from the
     number the agent itself acted on. `undefined` is tested as well as `null`
     because the archived payload omits the key. */
  const gapUnread = gap === null || gap === undefined;
  const onTarget = !gapUnread && Math.abs(gap) < 0.25;
  const gapChip = gapUnread ? (
    <span className="chip chip-sim">
      <Ed x="gap unread" p="gap not read yet" />
    </span>
  ) : onTarget ? (
    <span className="chip chip-teal">
      <Ed x="on target" p="where it wants to be" />
    </span>
  ) : (
    <span className="chip chip-gold">
      <Ed x="gap" p="off by" /> {num(gap)}
    </span>
  );

  const fills = state.fills.slice(0, SHOWN);
  /* AttackTape's rule: a column with nothing in it teaches nothing. Every
     archived fill carries the SAME seen_at (the snapshot stamp), so an age
     column would print one identical wrong number down all five rows; the
     staleness is already stated once, in the head chip. useNow returns 0 during
     SSR by contract, so the column waits for a real clock instead of rendering
     five blanks and reflowing on hydration. */
  const hasAge = live && nowS > 0 && fills.some((f) => f.seen_at > 0);
  const cols = hasAge ? 5 : 4;

  return (
    <Card
      indexId={state.index_id}
      chip={
        live ? (
          <span className="chip chip-teal">
            <span className="dot breathe" />
            <Ed x="agent wallet" p="its own wallet" />
          </span>
        ) : (
          <span className="chip chip-sim">
            <Ed x="archived standing" p="a saved copy" />
          </span>
        )
      }
    >
      <p className="muted" style={{ fontSize: 13, margin: 0, maxWidth: 68 * 9 }}>
        <Ed
          x="A compute buyer is short the rate it pays, so it hedges by going long the future. This agent buys the ACR print over x402, compares it to the position it already holds, and trades the difference. No human in the loop."
          p="This robot pays a fraction of a cent for today's price, then buys or sells to reach the target its owner set once."
        />
      </p>

      {/* Three headline figures, not five tiles. `.wallet-grid` is a two-column
          grid collapsing to one at 640px, so five tiles stranded a half-width
          orphan on row three against a 1192px container. `.lab-counters` is a
          wrapping flex row: it reserves no empty cell at any width, and it is
          the shape /sellers already uses for figures inside a card. */}
      <div className="lab-counters" style={{ marginTop: 20 }}>
        <div>
          <div className="counter-value gold" style={{ fontSize: 30 }}>
            {num(pos)}
          </div>
          <div className="counter-label label">
            <Ed x="contracts held · mandate" p="contracts it holds · goal" /> {num(target)}{" "}
            {gapChip}
          </div>
        </div>

        <div>
          <div className="counter-value" style={{ fontSize: 30 }}>
            {num(state.collateral_usdc)}
          </div>
          <div className="counter-label label">
            <Ed x="collateral posted · USDC" p="money it has at stake · USDC" />
          </div>
        </div>

        {/* The old tile printed `N × total`, which reads as a multiplication and
            is not one: the press SUMS amount_usdc across the agent's receipts
            and counts the rows separately, so that display overstated the spend
            by a factor of N. Two numbers, two places. */}
        <div>
          <div className="counter-value" style={{ fontSize: 30 }}>
            {num(state.spent_usdc, 4)}
          </div>
          <div className="counter-label label">
            <Ed x="spent on prints · USDC over" p="spent on prices · dollars across" />{" "}
            {state.paid_queries ?? "…"} <Ed x="paid reads" p="paid questions" />
          </div>
        </div>
      </div>

      {/* Which market, which contract, which two names. All four of these
          payload fields (index_id, venue, series_id, wallet_kind) used to be
          dropped, so the panel never said what it hedged or where. No nested
          `.panel` here: the whole block is the card now, and a card inside a
          card was the inverted hierarchy this restructure exists to remove. */}
      <div className="provenance" style={{ marginTop: 4 }}>
        <div className="provenance-row">
          <span className="label">
            <Ed x="venue · series" p="where it trades · round" />
          </span>
          <Val>
            {state.venue ? (
              <AddressChip address={state.venue} explorer={explorer} copy={false} />
            ) : (
              "…"
            )}
            <Qual>#{state.series_id ?? "…"}</Qual>
          </Val>
        </div>
        <div className="provenance-row">
          <span className="label">
            <Ed x="trades as" p="trades under the name" />
          </span>
          <Val>
            {state.agent ? <AddressChip address={state.agent} explorer={explorer} /> : "…"}
            {state.wallet_kind ? <Qual>{state.wallet_kind.replace(/-/g, " ")}</Qual> : null}
          </Val>
        </div>
        <div className="provenance-row">
          <span className="label">
            <Ed x="pays as" p="pays under" />
          </span>
          <Val>
            {state.payer ? <AddressChip address={state.payer} explorer={explorer} /> : "…"}
          </Val>
        </div>
      </div>

      <p className="muted" style={{ fontSize: 12.5, margin: "12px 0 0" }}>
        <Ed
          x="The payer is the smart account's backing EOA: EIP-3009 needs a signature ecrecover can verify."
          p="The second name signs the payments, because that system needs a different kind of signature."
        />
      </p>

      <div className="label" style={{ marginTop: 22, marginBottom: 8 }}>
        <Ed x="recent fills" p="recent trades" />
        {state.fills.length > SHOWN ? (
          <span className="muted">
            {" "}
            · {fills.length} of {state.fills.length}
          </span>
        ) : null}
      </div>

      {/* The empty case is a ROW, not a replacement for the table. The headers
          stand either way, so a reader with no fills still sees what would
          print here and gets one cell saying why it does not. `.sheet td.wrap`
          exists for exactly this — prose in a cell that must not force a
          sideways scroll on a phone — and a colSpan cell is td:first-child, so
          it left-aligns without an override. */}
      <div className="table-scroll">
        <table className="sheet">
          <thead>
            <tr>
              <th>
                <Ed x="side" p="bought or sold" />
              </th>
              <th>
                <Ed x="qty" p="how much" />
              </th>
              <th>
                <Ed x="mark" p="price" />
              </th>
              {hasAge ? (
                <th>
                  <Ed x="seen" p="when" />
                </th>
              ) : null}
              <th>
                <Ed x="tx" p="receipt" />
              </th>
            </tr>
          </thead>
          <tbody>
            {fills.length ? (
              fills.map((f) => (
                <tr key={f.tx}>
                  <td className={f.side === "buy" ? "green" : "vermilion"}>{f.side}</td>
                  <td className="mono">{formatQty(f.qty)}</td>
                  <td className="mono">{f.mark.toFixed(5)}</td>
                  {hasAge ? (
                    <td className="mono muted">
                      {tapeAge(f.seen_at, nowS, live ? "press" : "bundle").text}
                    </td>
                  ) : null}
                  <td>
                    <TxLink txRef={f.tx} explorer={explorer} />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                {/* Not "yet": the tape walks back ~8h (4 pages × 14000 blocks at
                    Arc's 0.510s), so an empty list means nothing inside that
                    window, not an agent that never traded. The taker filter
                    carries no series either, so the older copy's "on the live
                    series" was never earned. */}
                <td colSpan={cols} className="wrap muted">
                  <Ed
                    x="No fills inside the tape's ~8h reach. The position above is the durable witness."
                    p="No trades in the last eight hours or so. What it holds, above, is the lasting record."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="muted" style={{ fontSize: 12.5, margin: "16px 0 0" }}>
        <Ed
          x="Spend and position caps are enforced by the agent's own code: Circle's platform-enforced wallet policies are mainnet-only, so nothing here is guaranteed by the network."
          p="Its spending limits come from its own program, not from the bank, which only offers them on the real network."
        />
      </p>
    </Card>
  );
}
