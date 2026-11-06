"use client";

import { Ed } from "@/components/Ed";
import { TickerNumber } from "@/components/TickerNumber";
import type { FloatVaultState } from "@/lib/float";
import { fmtInt, fmtPrice, shortAddr } from "@/lib/format";
import { useFloatYield } from "@/lib/useLive";

/* What the idle float earned, and the sleeve that is not live.

   THIS IS THE PANEL THE TREASURY EXISTS FOR. Money not needed this minute
   earns until the second a bill needs it. Every other panel describes control;
   this one says whether the control bought anything.

   THE NUMBER IS A FLOOR, AND IT SAYS SO. The basis is summed from the sleeve's
   own `Parked` and `Pulled` events, and both round against us: a deposit is
   recorded before the venue rounds shares down, a withdrawal is recorded as
   the treasury's measured gain after the venue rounds shares up. So the gain
   shown is the least it can be. For a meter that must not overclaim, a floor
   is the correct direction of error, and `float/studio/README.md` records this
   repo already correcting an overclaim in exactly this area.

   IT CAN SHOW A LOSS. A share-priced venue can mark down. A meter that could
   only go up would be decoration.

   AND IT WITHHOLDS. If the walk did not reach the sleeve's first deposit the
   basis is missing money that went in, which makes the gain look bigger by
   precisely what was missed. There is no safe way to bound that from inside
   the window, so no number is shown at all. */

/** The tokenized Treasury-bill fund the reserve sleeve was designed for.
 *
 *  Read first-hand over this chain's public RPC on 2026-10-04 and recorded in
 *  `docs/TAMEION.md`: 183 bytes of proxy code, `symbol()` "USYC",
 *  `decimals()` 6. Named here rather than described so a reader can check the
 *  claim instead of taking it. */
const USYC = "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C";

function Row({
  label,
  units,
  total,
  fill,
  signed = false,
}: {
  label: React.ReactNode;
  units: number;
  total: number;
  fill: string;
  signed?: boolean;
}) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (Math.abs(units) / total) * 100)) : 0;
  return (
    <div className="meter-row">
      <span className="label">{label}</span>
      <span className="meter">
        <i className={fill} style={{ width: `${pct}%` }} />
      </span>
      <span className={`num mono${signed && units < 0 ? " vermilion" : signed ? " gold" : ""}`}>
        {signed && units > 0 ? "+" : ""}
        {fmtPrice(units)}
      </span>
    </div>
  );
}

export function Yield({ vault }: { vault: FloatVaultState }) {
  const { earned } = useFloatYield();
  const d = earned?.data ?? null;
  const live = Boolean(earned?.live) && d?.status === "ok";

  const value = d?.value_usdc ?? 0;
  const principal = d?.principal_usdc ?? 0;
  const gain = d?.accrued_usdc ?? null;
  const scale = Math.max(value, principal, 1);
  /* `null` means read-and-not-live, which is the banner. `undefined` means not
     read, which is not a claim about the design. */
  const reserveOff = vault.reserve === null;

  return (
    <section className="section anchor-target" id="earned">
      <div className="section-head">
        <h2 className="label">
          <Ed x="What the idle money earned" p="What the spare money earned" />
        </h2>
        <span className="label">
          {!live ? null : d?.complete ? (
            <span className="chip chip-teal">
              <Ed x="from the sleeve's own events" p="counted from the chain" />
            </span>
          ) : (
            <span className="chip chip-sim">
              <Ed x="basis incomplete" p="we could not read it all" />
            </span>
          )}
        </span>
      </div>

      {!live ? (
        <p className="muted awaiting">
          {d?.reason ? (
            <span className="mono">{d.reason}</span>
          ) : (
            <Ed x="reading what the sleeve holds." p="reading what the savings hold." />
          )}
        </p>
      ) : (
        <>
          <Row fill="fill-working" label={<Ed x="put in" p="put in" />} total={scale} units={principal} />
          <Row fill="fill-buffer" label={<Ed x="worth now" p="worth now" />} total={scale} units={value} />

          {gain === null ? (
            <p className="label">
              <span className="chip chip-sim chip-wrap">
                <Ed
                  x="no gain shown: the walk did not reach the first deposit"
                  p="no figure here: we could not read far enough back"
                />
              </span>
            </p>
          ) : (
            <div className="meter-row">
              <span className="label">
                <Ed x="earned" p="earned" />
              </span>
              <span className="meter">
                <i className="fill-reserve" style={{ width: `${scale > 0 ? Math.min(100, (Math.abs(gain) / scale) * 100) : 0}%` }} />
              </span>
              <span className={`num mono${gain < 0 ? " vermilion" : gain > 0 ? " gold" : " muted"}`}>
                <TickerNumber className="num" quiet text={`${gain > 0 ? "+" : ""}${fmtPrice(gain)}`} />
              </span>
            </div>
          )}

          {gain === 0 ? (
            /* An exact zero is a reading, not a failure. A share-priced venue
               that has not paid yet converts back to precisely what went in,
               and saying so is better than a bare 0 that looks broken. */
            <p className="label">
              <span className="chip chip-sim">
                <Ed
                  x="nothing yet: this venue has not paid on a test network"
                  p="nothing yet: this vault has not paid out on a test network"
                />
              </span>
            </p>
          ) : null}

          <p className="label mono">
            <Ed x="earning in" p="earning in" />{" "}
            <span className="num">{d?.venue ? shortAddr(d.venue) : "…"}</span>
            {" · "}
            <span className="num">{fmtInt(d?.parked_count ?? 0)}</span> <Ed x="deposits" p="deposits" />
            {" · "}
            <span className="num">{fmtInt(d?.pulled_count ?? 0)}</span>{" "}
            <Ed x="pulls back out" p="times money came back" />
          </p>

          <Ed
            as="p"
            className="muted"
            style={{ fontSize: "var(--t-3)", marginTop: "var(--s-3)", maxWidth: "var(--measure)" }}
            x="Float adds no yield of its own: this is whatever the venue paid, counted from the sleeve's own deposits and withdrawals. Both roundings go against us, so it is the least that was earned rather than an estimate, and there is no annual rate here because eleven hours of a test network cannot support one."
            p="This is what the vault paid, not something we added. It is counted the careful way, so it is the least that was earned."
          />
        </>
      )}

      {reserveOff ? (
        <>
          <div className="block-head">
            <h3 className="label">
              <Ed x="The second sleeve, and why it is not live" p="The second pot, and why it is off" />
            </h3>
          </div>
          <Ed
            as="p"
            className="muted"
            style={{ fontSize: "var(--t-4)", marginTop: 0, maxWidth: "var(--measure)" }}
            x="The reserve sleeve was designed for a tokenized Treasury bill fund. It is deployed on this chain and we read it rather than taking the page's word: the token answers to its own name and six decimals, and a teller buys and sells it against USDC. What stops it is an allowlist, not a contract, and the ticket that opens one takes a day or two."
            p="The second pot was meant to hold Treasury bills. The fund is real and on this chain. What stops us is a waiting list, not the code."
          />
          <p className="label mono">
            <Ed x="the fund" p="the fund" /> <span className="num">{shortAddr(USYC)}</span>
            {" · "}
            <span className="chip chip-sim">
              <Ed x="not wired to this treasury" p="not connected yet" />
            </span>
          </p>
          <Ed
            as="p"
            className="muted"
            style={{ fontSize: "var(--t-3)", marginTop: "var(--s-3)", maxWidth: "var(--measure)" }}
            x="The vault holds a zero address for it rather than a stand-in, which is the whole reason this panel can be believed: a mock yield venue would have printed a number here."
            p="The vault holds nothing there rather than a stand-in. A fake one would have shown a number here."
          />
        </>
      ) : null}
    </section>
  );
}
