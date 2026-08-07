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
 * Built from the house vocabulary rather than its own: `.wallet-row` tiles for
 * the standings, `.provenance-row` inside a glass panel for the identities, and
 * `table.sheet` for the fills. The tables here used to carry className="table",
 * a class that exists in no stylesheet — so they rendered at browser defaults,
 * in the body font, with a first column that did not sit flush with any
 * neighbouring table on the page. That was the "column looks out of place". */

import type { HedgerState } from "@/lib/types";
import { formatQty } from "@/lib/futuresBook";
import { Ed } from "@/components/Ed";
import { AddressChip } from "@/components/chain/AddressChip";
import { TxLink } from "@/components/chain/TxLink";

function num(v: number | null | undefined, digits = 2, suffix = ""): string {
  return v === null || v === undefined ? "…" : `${v.toFixed(digits)}${suffix}`;
}

/** One standing, as a bordered tile: label above, mono figure below. The same
 *  shape the wallet panel uses two sections up, so the two read as one system. */
function Stat({
  label,
  value,
  chip,
}: {
  label: React.ReactNode;
  value: string;
  chip?: React.ReactNode;
}) {
  return (
    <div className="wallet-row">
      <div className="wallet-role">
        <span className="label">{label}</span>
        {chip ?? null}
      </div>
      <div className="wallet-figures">
        <span className="mono">{value}</span>
      </div>
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
        <p className="muted" style={{ fontSize: 13, maxWidth: 68 * 9 }}>
          <Ed
            x="No hedger agent is configured on this deployment. Set ACR_HEDGER_ADDRESS to the Circle agent wallet."
            p="No robot trader is switched on here right now."
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

      <p className="muted" style={{ fontSize: 13, marginTop: 0, maxWidth: 68 * 9 }}>
        <Ed
          x="A compute buyer is short the rate it pays, so it hedges by going long the future. This agent buys the ACR print over x402, compares it to the position it already holds, and trades the difference. No human in the loop."
          p="This robot pays a fraction of a cent for today's price, then buys or sells to reach the target its owner set once."
        />
      </p>

      <div className="wallet-grid">
        <Stat label={<Ed x="mandate" p="the goal" />} value={num(target)} />
        <Stat label={<Ed x="position" p="what it holds" />} value={num(pos)} />
        <Stat
          label={<Ed x="gap" p="how far off" />}
          value={num(gap)}
          chip={
            onTarget ? (
              <span className="chip chip-teal">
                <Ed x="on target" p="where it wants to be" />
              </span>
            ) : null
          }
        />
        <Stat
          label={<Ed x="collateral" p="money at stake" />}
          value={num(state.collateral_usdc, 2, " USDC")}
        />
        <Stat
          label={<Ed x="paid for data" p="spent on prices" />}
          value={
            state.paid_queries === null
              ? "…"
              : `${state.paid_queries} × ${num(state.spent_usdc, 4, " USDC")}`
          }
        />
      </div>

      {/* Two addresses, one agent. Side by side in a glass panel rather than
          stacked as four loose blocks, so the pairing is visible at a glance. */}
      <div className="panel panel-pad" style={{ marginTop: 14 }}>
        <div className="provenance">
          <div className="provenance-row">
            <span className="label">
              <Ed x="trades as" p="trades under the name" />
            </span>
            <span className="val">
              {state.agent ? <AddressChip address={state.agent} explorer={explorer} /> : "…"}
            </span>
          </div>
          <div className="provenance-row">
            <span className="label">
              <Ed x="pays as" p="pays under" />
            </span>
            <span className="val">
              {state.payer ? <AddressChip address={state.payer} explorer={explorer} /> : "…"}
            </span>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>
          <Ed
            x="The payer is the smart account's backing EOA: EIP-3009 needs a signature ecrecover can verify."
            p="The second name signs the payments, because that system needs a different kind of signature."
          />
        </p>
      </div>

      <div style={{ marginTop: 18 }}>
        <span className="label">
          <Ed x="recent fills" p="recent trades" />
        </span>
      </div>
      {state.fills.length > 0 ? (
        <div className="table-scroll" style={{ marginTop: 8 }}>
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
        <p className="muted" style={{ fontSize: 13, marginTop: 8, maxWidth: 68 * 9 }}>
          {/* Not "yet": the tape walks back ~8h (4 pages × 14000 blocks at Arc's
              0.510s), so an empty list means nothing in that window, not an agent
              that never traded. The taker filter carries no series either, so the
              older copy's "on the live series" was never earned. */}
          <Ed
            x="No fills inside the tape's ~8h reach. The position above is the durable witness."
            p="No trades in the last eight hours or so. What it holds, above, is the lasting record."
          />
        </p>
      )}

      <p className="muted" style={{ fontSize: 13, marginTop: 16, maxWidth: 68 * 9 }}>
        <Ed
          x="Spend and position caps are enforced by the agent's own code: Circle's platform-enforced wallet policies are mainnet-only, so nothing here is guaranteed by the network."
          p="Its spending limits come from its own program, not from the bank, which only offers them on the real network."
        />
      </p>
    </section>
  );
}
