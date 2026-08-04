"use client";

/* The autonomous hedger — the only agent here that makes an economic decision.
 *
 * Every other machine on this site does one leg: the buyer pays for data it
 * never uses, the heartbeat trades without paying for what it trades on. This
 * one buys the index and then acts on what it read, from a Circle agent wallet
 * that holds no exportable key.
 *
 * Two addresses, one agent (docs/WALLETS.md): the smart account is what the
 * venue records as the taker, and its backing EOA is what the settlement
 * records as the payer. Both are shown, because a reader checking the explorer
 * would otherwise find two strangers and no explanation.
 *
 * Nulls render as "—", never as 0. An unread balance and an empty one call for
 * opposite conclusions, and this panel refuses to collapse them. */

import type { HedgerState } from "@/lib/types";
import { formatQty } from "@/lib/futuresBook";
import { Ed } from "@/components/Ed";
import { AddressChip } from "@/components/chain/AddressChip";
import { TxLink } from "@/components/chain/TxLink";

function num(v: number | null | undefined, digits = 2, suffix = ""): string {
  return v === null || v === undefined ? "—" : `${v.toFixed(digits)}${suffix}`;
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
  const head = (
    <div className="section-head">
      <span className="label">
        <Ed x="autonomous hedger" p="the robot that hedges its own bill" />
      </span>
      {live && state?.configured ? (
        <span className="chip chip-teal">
          <span className="dot breathe" />
          <Ed x="agent wallet" p="its own wallet" />
        </span>
      ) : null}
    </div>
  );

  if (!state?.configured) {
    return (
      <section className="section">
        {head}
        <p className="muted">
          <Ed
            x="no hedger agent is configured on this deployment — set ACR_HEDGER_ADDRESS to the Circle agent wallet."
            p="no robot trader is switched on here right now."
          />
        </p>
      </section>
    );
  }

  const { position_contracts: pos, target_contracts: target, gap_contracts: gap } = state;
  const onTarget = gap !== null && Math.abs(gap) < 0.25;

  return (
    <section className="section">
      {head}

      <p className="muted">
        <Ed
          x="A compute buyer is short the rate it pays, so it hedges by going long the future. This agent buys the ACR print over x402, compares it to the position it already holds, and trades the difference — no human in the loop."
          p="A business that buys computing wants protection from the price going up. So this robot pays a fraction of a cent for today's price, checks what it already holds, and buys or sells the difference — on its own, with nobody pressing a button. It aims at a target its owner set once."
        />
      </p>

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>
                <Ed x="mandate" p="the goal" />
              </th>
              <th>
                <Ed x="position" p="what it holds" />
              </th>
              <th>
                <Ed x="gap" p="how far off" />
              </th>
              <th>
                <Ed x="collateral" p="money at stake" />
              </th>
              <th>
                <Ed x="paid for data" p="spent on prices" />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">{num(target)}</td>
              <td className="mono">{num(pos)}</td>
              <td className="mono">
                {num(gap)}
                {onTarget ? <span className="chip chip-teal">on target</span> : null}
              </td>
              <td className="mono">{num(state.collateral_usdc, 2, " USDC")}</td>
              <td className="mono">
                {state.paid_queries === null
                  ? "—"
                  : `${state.paid_queries} × ${num(state.spent_usdc, 4, " USDC")}`}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="muted">
        <Ed x="trades as" p="trades under the name" />{" "}
      </p>
      {state.agent ? <AddressChip address={state.agent} explorer={explorer} /> : null}
      <p className="muted">
        <Ed
          x="pays as (the smart account's backing EOA — EIP-3009 needs a signature ecrecover can verify)"
          p="pays under a second name, because the payment system needs a different kind of signature. Both names are the same robot."
        />{" "}
      </p>
      {state.payer ? <AddressChip address={state.payer} explorer={explorer} /> : null}

      {state.fills.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
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
                <th>
                  <Ed x="tx" p="receipt" />
                </th>
              </tr>
            </thead>
            <tbody>
              {state.fills.slice(0, 5).map((f) => (
                <tr key={f.tx}>
                  <td className={f.side === "buy" ? "teal" : "vermilion"}>{f.side}</td>
                  <td className="mono">{formatQty(f.qty)}</td>
                  <td className="mono">{f.mark.toFixed(5)}</td>
                  <td>
                    <TxLink txRef={f.tx} explorer={explorer} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">
          <Ed
            x="no fills from this agent yet on the live series."
            p="this robot has not made any trades yet on the current round."
          />
        </p>
      )}

      <p className="muted">
        <Ed
          x="Spend and position caps are enforced by the agent's own code: Circle's platform-enforced wallet policies are mainnet-only, so nothing here is guaranteed by the network."
          p="Its spending limits are enforced by its own program, not by the bank — the bank only offers that on the real network, not this test one."
        />
      </p>
    </section>
  );
}
