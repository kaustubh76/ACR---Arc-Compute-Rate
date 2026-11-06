"use client";

import { Ed } from "@/components/Ed";
import type { FloatVaultState } from "@/lib/float";
import { fmtPrice } from "@/lib/format";

/* Where the float is: the buffer, and the sleeves it earns in.

   THREE ROWS AND NOT A STACKED BAR. `.meter i` fills from the left edge, so a
   stack would need offsets that re-derive each row's start from the one before
   it — arithmetic that is wrong the first time a sleeve is absent. Three
   proportions of one total read the same and cannot drift.

   AN ABSENT SLEEVE IS NOT AN EMPTY ONE, and this is the distinction the panel
   exists to keep. The reserve ships as a null sleeve pending an allowlist and
   reverts by design; printing it as 0.00 USDC would describe a yield venue
   standing empty rather than one that is not live yet. `ACR_Float.md` is
   explicit about which of those is allowed on screen: a banner, never a mock. */

function Row({ label, value, total, fill }: { label: React.ReactNode; value: number; total: number; fill: string }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
  return (
    <div className="meter-row">
      <span className="label">{label}</span>
      <span className="meter">
        <i className={fill} style={{ width: `${pct}%` }} />
      </span>
      <span className="num mono">{fmtPrice(value)}</span>
    </div>
  );
}

export function VaultMeter({ vault }: { vault: FloatVaultState }) {
  const buffer = vault.buffer_usdc ?? 0;
  const working = vault.working;
  const reserve = vault.reserve;
  const total = vault.total_usdc ?? buffer + (working?.value_usdc ?? 0) + (reserve?.value_usdc ?? 0);

  return (
    <section className="section anchor-target" id="float">
      <div className="section-head">
        <h2 className="label">
          <Ed x="Where the float is" p="Where the money sits" />
        </h2>
        <span className="label">
          <span className="chip chip-teal">
            <Ed x="total free float" p="all of it" />{" "}
            <span className="num">{fmtPrice(total)}</span>
          </span>
        </span>
      </div>

      <Row
        fill="fill-buffer"
        label={<Ed x="buffer" p="ready to pay" />}
        total={total}
        value={buffer}
      />
      {working ? (
        <Row
          fill="fill-working"
          label={<Ed x="working sleeve" p="earning" />}
          total={total}
          value={working.value_usdc}
        />
      ) : null}
      {reserve ? (
        <Row
          fill="fill-reserve"
          label={<Ed x="reserve sleeve" p="held back" />}
          total={total}
          value={reserve.value_usdc}
        />
      ) : null}

      {/* `null` is read-and-not-live, which is the banner the product needs.
          `undefined` is not-read, and drawing the banner for it would announce
          a design decision on the strength of a rate limit. */}
      {reserve === null ? (
        <p className="label">
          <span className="chip chip-sim">
            <Ed x="reserve sleeve not live" p="the second pot is not switched on" />
          </span>
        </p>
      ) : null}
      {reserve === undefined || working === undefined ? (
        <p className="label">
          <span className="chip chip-sim">
            <Ed x="a sleeve could not be read just now" p="we could not read one of the pots" />
          </span>
        </p>
      ) : null}

      <Ed
        as="p"
        className="muted"
        style={{ fontSize: "var(--t-4)", marginTop: "var(--s-4)", maxWidth: "var(--measure)" }}
        x="Idle float sits in a real yield vault on this chain. The buffer is what is left for the next payment, and a payment larger than it pulls the exact shortfall back in the same transaction rather than waiting for a rebalance."
        p="Spare money earns in a real vault. What is left over pays the next bill, and more is pulled back the moment a bill needs it."
      />
    </section>
  );
}
