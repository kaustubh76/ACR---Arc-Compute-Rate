"use client";

import { useState } from "react";

import { Ed } from "@/components/Ed";
import { TickerNumber } from "@/components/TickerNumber";
import { addrUrl } from "@/lib/chain";
import { RESERVE_RECORD, previewDeposit, previewRedeem, reserveShareBps, slotIsEmpty } from "@/lib/floatReserve";
import { CHAINS } from "@/lib/chainChoice";
import type { FloatVaultState } from "@/lib/float";
import { fmtInt, fmtPrice, shortAddr } from "@/lib/format";
import { useChain } from "@/lib/useChain";
import { useFloatReserve, useFloatYield } from "@/lib/useLive";

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
 *  NOW ONLY THE FALLBACK LABEL, shown while the read is in flight. The address
 *  the panel renders comes off `/api/float/reserve`, which reads the fund's own
 *  symbol, decimals, supply and code size rather than asserting them, and
 *  compares the answers against what `docs/TAMEION.md` recorded on 2026-10-04:
 *  183 bytes of proxy code, `symbol()` "USYC", `decimals()` 6. The per-chain
 *  addresses live in `lib/floatReserve.ts`; this constant is kept so a reader
 *  still sees an address during the first paint rather than an ellipsis. */
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

/** One gate, as the venue answers it for us.
 *
 *  THREE STATES AND NOT TWO. `null` is a read that did not come back, and it
 *  renders as "unread" rather than "closed": the collapse of a throttled read
 *  into a refusal would print the most frightening sentence on the page out of
 *  a rate limit. Four gates is four chances to do that. */
function GateMark({ open }: { open: boolean | null }) {
  if (open === null) {
    return (
      <span className="chip chip-sim">
        <Ed x="unread" p="unread" />
      </span>
    );
  }
  return (
    <span className={open ? "chip chip-teal" : "chip chip-breach"}>
      {open ? <Ed x="open" p="open" /> : <Ed x="CLOSED" p="CLOSED" />}
    </span>
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

  /* The explorer of the chain being SERVED, not the default. `CHAIN.explorer`
     is mainnet's, and this panel only ever renders for the one chain the vault
     is deployed to, so taking the default would hand a reader a link to the
     wrong network's explorer for an address that does not exist there. */
  const explorer = CHAINS[useChain()].profile.explorer;

  const gates = d?.gates ?? null;
  /* ORDER MATTERS IN THESE TWO. `shut` is checked before `unreadGate` so a
     gate that genuinely answered "no" is never softened into "we could not
     tell" by an unrelated read that failed beside it. A real refusal outranks
     a missing one. */
  const shut = gates ? Object.values(gates).some((g) => g === false) : false;
  const unreadGate = gates ? Object.values(gates).some((g) => g === null) : false;

  /* THE FUND, READ. The prose below has always said "we read it rather than
     taking the page's word", and until now that described something done once
     by hand in October and written into a markdown file. It is literally true
     from this hook onwards. */
  const { fund } = useFloatReserve();
  const f = fund?.data ?? null;
  /* A real 0 means "nothing is deployed there", which is the one answer this
     panel exists to be able to give; `null` and `undefined` both mean "not
     read". They must not share a rendering. */
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "…" : fmtInt(v));

  /* THE SECOND GATE, AND IT IS OURS. `rebalance` computes
     `toReserve = excess - excess * workingShareBps / 10_000`, so the reserve's
     share of every sweep is exactly what the working sleeve did not take. The
     vault sits at 10000, which makes that remainder zero: the T-bill leg would
     receive nothing even with a sleeve wired and Circle's permission granted.
     The panel named the allowlist as the only obstacle and left this out. */
  const reserveShare = reserveShareBps(vault.policy?.working_share_bps);
  const [putIn, setPutIn] = useState(0);

  /* THE HALF THAT WORKS, AND IT GOES FIRST.
     Everything else in this panel reads Circle's fund, which refuses us, so
     the panel could only ever explain a shut door. `UsycSleeve` is the same
     contract that would face Circle's teller, deployed in front of a published
     stand-in fund, and it is the one address in this story holding a position.

     NOT A TREASURY FIGURE, AND IT SAYS SO. The sleeve answers to the deploy key
     rather than the vault, exactly so no simulated number can reach
     `totalValueUsdc()`, so this block wears `chip-sim` and is summed into
     nothing.

     THE WHAT-IF SPENDS NO RPC CALL. One NAV read, then `previewDeposit` and
     `previewRedeem` — ports of the teller's own arithmetic, pinned in
     `lib/floatReserve.test.ts`. The round trip is the point: what comes back is
     less than what went in, because `previewRedeem` takes the fund's
     redemption fee off, and `UsycSleeve.valueUsdc()` deliberately quotes that
     net figure rather than balance times NAV. */
  const navWad = f?.nav_wad ? BigInt(f.nav_wad) : null;
  const navPerShare = navWad === null ? null : Number(navWad) / 1e18;
  const ceiling = vault.total_usdc ?? 0;
  const putUnits = BigInt(Math.round(putIn * 1e6));
  const shares = previewDeposit(putUnits, navWad);
  const backUnits = shares === null ? null : previewRedeem(shares, navWad, f?.nav_fee_bps);

  const bench = f?.sleeve ? (
    <>
      <div className="block-head">
        <h3 className="label">
          <Ed x="The same sleeve, driven on a stand-in fund" p="The same pot, tried on a practice fund" />
        </h3>
        <span className="label">
          <span className="chip chip-sim">
            <Ed x="stand-in fund, published source" p="a practice fund, not real money" />
          </span>
        </span>
      </div>
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: "var(--t-4)", marginTop: 0, maxWidth: "var(--measure)" }}
        x="This is the contract that would face Circle's teller, deployed in front of a stand-in fund, so the mechanism runs today."
        p="This is the same code, tried on a practice fund, so you can watch it work."
      />
      <p className="label mono">
        <Ed x="our sleeve" p="our pot" />{" "}
        <a className="tx-link" href={addrUrl(f.sleeve, explorer)} rel="noreferrer" target="_blank" title={f.sleeve}>
          {shortAddr(f.sleeve)} <span className="ext">↗</span>
        </a>
        {" · "}
        <Ed x="holds" p="holds" />{" "}
        <span className="num">
          {f.sleeve_value_usdc === null || f.sleeve_value_usdc === undefined ? "…" : fmtPrice(f.sleeve_value_usdc)}
        </span>{" "}
        <Ed x="USDC, net of the fund's fee" p="dollars, after the fund's fee" />
        {f.sleeve_code_bytes ? (
          <>
            {" · "}
            <span className="num">{fmtInt(f.sleeve_code_bytes)}</span> <Ed x="bytes of code" p="bytes of code" />
          </>
        ) : null}
      </p>
      <p className="label mono">
        <Ed x="the stand-in fund" p="the practice fund" />{" "}
        {f.bench_teller ? (
          <a className="tx-link" href={addrUrl(f.bench_teller, explorer)} rel="noreferrer" target="_blank" title={f.bench_teller}>
            {shortAddr(f.bench_teller)} <span className="ext">↗</span>
          </a>
        ) : (
          <span className="num">…</span>
        )}
        {" · "}
        <Ed x="price per share" p="price for one share" />{" "}
        <span className="num">{navPerShare === null ? "…" : navPerShare.toFixed(6)}</span>
        {f?.nav_fee_bps ? (
          <>
            {" · "}
            <Ed x="redemption fee" p="fee to cash out" />{" "}
            <span className="num">{(f.nav_fee_bps / 100).toFixed(2)}</span>
            {"%"}
          </>
        ) : null}
      </p>

      {navWad !== null && ceiling > 0 ? (
        <>
          <div className="flow-controls">
            <label className="label">
              <Ed x="what-if: put this much in" p="what-if: put this much in" />{" "}
              <input
                aria-label="a what-if deposit into the stand-in Treasury bill fund, in USDC"
                aria-valuetext={`${fmtPrice(putIn)} USDC`}
                max={ceiling}
                min={0}
                onChange={(e) => setPutIn(Number(e.target.value))}
                step="any"
                type="range"
                value={putIn}
              />{" "}
              <b className="gold mono">{fmtPrice(putIn)}</b>
            </label>
            {putIn > 0 ? (
              <button className="chip" onClick={() => setPutIn(0)} type="button">
                <Ed x="put it back" p="put it back" />
              </button>
            ) : null}
          </div>
          <p aria-live="polite" className="label mono" role="status">
            {putIn <= 0 ? (
              <Ed
                x="nothing in: the price above is the fund's own, read from chain."
                p="nothing in yet. The price above is the real one."
              />
            ) : (
              <>
                <Ed x="the fund would mint" p="you would get" />{" "}
                <span className="num gold">{shares === null ? "…" : fmtPrice(Number(shares) / 1e6)}</span>{" "}
                <Ed x="shares" p="shares" />
                {" · "}
                <Ed x="redeeming them returns" p="cashing them out returns" />{" "}
                <span className="num">{backUnits === null ? "…" : fmtPrice(Number(backUnits) / 1e6)}</span>{" "}
                {/* A FEE THAT WAS NOT CHARGED MUST NOT BE CLAIMED. This said
                    "the fee taken off" unconditionally, and the stand-in's
                    `redemptionFeeBps` is 0 today — so the page read as though a
                    deduction had happened while quoting a round trip that came
                    back whole. The number was right and the sentence was not,
                    which is the worse of the two. */}
                {f?.nav_fee_bps ? (
                  <Ed x="USDC, the fund's fee taken off" p="dollars, with the fee taken off" />
                ) : (
                  <Ed x="USDC, and this fund's fee is zero today" p="dollars. This fund takes no fee today" />
                )}
              </>
            )}
          </p>
        </>
      ) : null}
    </>
  ) : null;


  const pf = d?.performance_fee_pct;
  const mf = d?.management_fee_pct_year;
  const feeUnread = pf === null || mf === null;
  const feeFree = !feeUnread && !pf && !mf;

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
            {/* THE ONE ADDRESS ON THIS SURFACE THAT WAS NOT CHECKABLE. The
                panel asserted a venue and gave a reader no way to go and look
                at it, while every receipt in the tape deep-links. */}
            {d?.venue ? (
              <a className="tx-link" href={addrUrl(d.venue, explorer)} rel="noreferrer" target="_blank" title={d.venue}>
                {shortAddr(d.venue)} <span className="ext">↗</span>
              </a>
            ) : (
              <span className="num">…</span>
            )}
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
            x="Float adds no yield of its own: whatever the venue paid, from the sleeve's own events, rounded against us. No annual rate; the window is too short."
            p="This is what the vault paid, not something we added. It is counted the careful way, so it is the least that was earned."
          />

          {/* WHAT WE ARE TRUSTING, which is a different question from what we
              earned and the one the panel could not answer. Everything above
              is backward-looking and exact. None of it says whether the venue
              would still let the money out, and the sleeve meter now animates
              a pull out of this venue on demand. These four booleans are the
              only thing on the page that checks that animation.

              THE EXIT PAIR COMES FIRST, because it is the pair that can trap
              us. Redeeming shares and receiving USDC back are what a pull
              actually does; the way in only costs us the chance to deposit. */}
          {gates ? (
            <>
              <div className="block-head">
                <h3 className="label">
                  <Ed x="What has to stay open for the money to come back" p="What has to stay open to get the money out" />
                </h3>
                <span className="label">
                  {shut ? (
                    <span className="chip chip-breach">
                      <Ed x="a gate is closed" p="a door is shut" />
                    </span>
                  ) : unreadGate ? (
                    <span className="chip chip-sim">
                      <Ed x="makes no claim: a gate did not answer" p="we cannot say: one answer did not arrive" />
                    </span>
                  ) : (
                    <span className="chip chip-teal">
                      <Ed x="both directions open" p="both ways are open" />
                    </span>
                  )}
                </span>
              </div>
              <p className="label">
                <Ed x="our exit" p="getting it out" />{" "}
                <GateMark open={gates.send_shares} /> <Ed x="redeem shares" p="cash in the receipt" />{" "}
                <GateMark open={gates.receive_assets} /> <Ed x="take USDC back" p="take the money back" />
              </p>
              <p className="label">
                <Ed x="our way in" p="putting it in" />{" "}
                <GateMark open={gates.send_assets} /> <Ed x="send USDC" p="send the money" />{" "}
                <GateMark open={gates.receive_shares} /> <Ed x="receive shares" p="get a receipt" />
              </p>
              <Ed
                as="p"
                className="muted"
                style={{ fontSize: "var(--t-3)", marginTop: "var(--s-3)", maxWidth: "var(--measure)" }}
                x="Asked of the venue as it answers for this sleeve, not inferred from whether a gate is installed. A gate that did not answer stays unread, never a refusal."
                p="We ask the vault directly whether it will still let this money move, rather than guessing from its settings."
              />
            </>
          ) : null}

          {/* AND WHAT IT COSTS US. The paragraph above says Float adds no yield
              of its own, which was only ever half the sentence: the venue could
              be taking a cut before we ever see a number. Both fees are `uint96`
              and scaled differently, so the server annualises the management one
              rather than leaving a per-second rate to be misread as a year. */}
          {d?.performance_fee_pct === undefined && d?.management_fee_pct_year === undefined ? null : (
            <p className="label mono">
              {feeFree ? (
                <span className="chip chip-teal">
                  <Ed x="the venue takes no fee" p="the vault takes no cut" />
                </span>
              ) : feeUnread ? (
                <span className="chip chip-sim">
                  <Ed x="the fees could not be read" p="we could not read the fees" />
                </span>
              ) : (
                <span className="chip chip-gold">
                  <Ed x="a fee is on" p="it takes a cut" />
                </span>
              )}
              {d?.performance_fee_pct ? (
                <>
                  {" · "}
                  <span className="num">{d.performance_fee_pct.toFixed(2)}</span>
                  {"% "}
                  <Ed x="of interest" p="of what it earns" />
                </>
              ) : null}
              {d?.management_fee_pct_year ? (
                <>
                  {" · "}
                  <span className="num">{d.management_fee_pct_year.toFixed(2)}</span>
                  {"% "}
                  <Ed x="a year" p="a year" />
                </>
              ) : null}
            </p>
          )}
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
            x="The reserve sleeve was built for a tokenized Treasury bill fund, read here rather than asserted. Three things must be true before it earns; one is Circle's."
            p="The second pot was meant to hold Treasury bills. The fund is real. Three things must be true before it earns, and two are ours."
          />
          {bench}
          <p className="label mono">
            <Ed x="the fund" p="the fund" />{" "}
            {f?.token ? (
              <a className="tx-link" href={addrUrl(f.token, explorer)} rel="noreferrer" target="_blank" title={f.token}>
                {shortAddr(f.token)} <span className="ext">↗</span>
              </a>
            ) : (
              <span className="num">{shortAddr(USYC)}</span>
            )}
            {" · "}
            {/* THE TICKER, SAID RATHER THAN HOPED FOR. This was
                `f?.symbol ?? "…"`, so the one word a reader searches for
                reached the page only when a 120-second poll had already
                landed — and the page can render perfectly with the ticker
                nowhere on it, which is exactly what a reader reported. The
                record is the 2026-10-04 reading in `docs/TAMEION.md`, and the
                chip below already says if a live read ever disagrees with it. */}
            <span className="num">{f?.symbol ?? RESERVE_RECORD.symbol}</span>
            {" · "}
            <span className="num">{num(f?.decimals)}</span> <Ed x="decimals" p="decimals" />
            {" · "}
            <Ed x="whole fund" p="the whole fund" />{" "}
            <span className="num">
              {f?.supply === null || f?.supply === undefined ? "…" : fmtPrice(f.supply)}
            </span>
          </p>
          <p className="label mono">
            <Ed x="the teller that mints and redeems it" p="the desk that buys and sells it" />{" "}
            {f?.teller ? (
              <a className="tx-link" href={addrUrl(f.teller, explorer)} rel="noreferrer" target="_blank" title={f.teller}>
                {shortAddr(f.teller)} <span className="ext">↗</span>
              </a>
            ) : (
              <span className="num">…</span>
            )}
            {" · "}
            {/* BYTES OF CODE AT EACH, which is how "deployed" stops being a
                word a reader has to take. A real 0 would say nothing is there. */}
            <Ed x="code on chain" p="code on chain" />{" "}
            <span className="num">{num(f?.token_code_bytes)}</span>
            {" / "}
            <span className="num">{num(f?.teller_code_bytes)}</span> <Ed x="bytes" p="bytes" />
          </p>
          <p className="label">
            {/* The record is `docs/TAMEION.md`, read first-hand on 2026-10-04.
                Comparing against it rather than merely displaying means a
                redeploy behind the proxy that changed the decimals would SAY
                so, instead of quietly rendering a different number under the
                same prose. `null` is not-read and claims nothing either way. */}
            {f?.agrees_with_record === true ? (
              <span className="chip chip-teal chip-wrap">
                <Ed x="the live reads match what we recorded" p="it still matches what we wrote down" />
              </span>
            ) : f?.agrees_with_record === false ? (
              <span className="chip chip-breach chip-wrap">
                <Ed x="the fund no longer matches our record" p="the fund does not match what we wrote down" />
              </span>
            ) : null}{" "}
            <span className="chip chip-sim">
              <Ed x="this treasury holds" p="this treasury holds" />{" "}
              <span className="num">
                {f?.held === null || f?.held === undefined ? "…" : fmtPrice(f.held)}
              </span>
            </span>{" "}
            <span className="chip chip-sim">
              <Ed x="not wired to this treasury" p="not connected yet" />
            </span>
          </p>
          {/* WOULD IT TAKE OUR MONEY. This panel used to say we could not read
              our own eligibility, and that was true of every accessor: the
              Teller has none, and `maxDeposit(address)` reports a non-zero
              allowance for an address that cannot deposit at all. The answer
              only exists by attempting the deposit, as a staticcall, where the
              revert IS the answer. So the page shows the chain's own refusal
              and the error it refused by, rather than a sentence about a queue.

              THE CONTROL IS SHOWN NEXT TO IT ON PURPOSE. A refusal on its own
              could be about our balance or anything else incidental to us; the
              same refusal for an address nobody could claim is allowlisted is
              what makes it a reading of permission. Claiming the first without
              the second would be the same shape of overclaim as the allowance
              getter this replaces. */}
          {f?.deposit_refused === null || f?.deposit_refused === undefined ? null : (
            <p className="label">
              {f.deposit_refused ? (
                <span className="chip chip-breach chip-wrap">
                  <Ed x="the fund refuses this treasury" p="the fund says no to us" />{" "}
                  <span className="mono">{f.deposit_refusal}</span>
                </span>
              ) : (
                <span className="chip chip-teal chip-wrap">
                  <Ed x="the fund would accept a deposit from this treasury" p="the fund would take our money" />
                </span>
              )}{" "}
              {f.deposit_refused && f.control_refusal ? (
                f.control_refusal === f.deposit_refusal ? (
                  <span className="chip chip-sim chip-wrap">
                    <Ed
                      x="an unrelated address is refused the same way, so this is reading permission"
                      p="a stranger gets the same answer, so this really is about permission"
                    />
                  </span>
                ) : (
                  <span className="chip chip-sim chip-wrap">
                    <Ed
                      x="an unrelated address is refused differently, so this says less than it looks"
                      p="a stranger gets a different answer, so we cannot be sure why"
                    />
                  </span>
                )
              ) : null}
            </p>
          )}
          {/* THE CLAIM, READ RATHER THAN ASSERTED. The sentence below has
              always been the strongest thing this panel says — a mock yield
              venue would have printed a number — and it was the only claim
              here still made by the page instead of by the chain. `reserve()`
              returns the zero address and now says so in its own characters.
              Absent when the read did not come back: a throttled read must not
              render as a confident zero address. */}
          {/* GATED ON THE READ THAT PRODUCES IT, which it was not. This said
              `d?.status === "ok" && vault.reserve_slot`, where `d` is the
              YIELD payload — a different endpoint on a different poll. A
              throttle on the working sleeve's event walk silently deleted the
              strongest sentence on this panel. `vault.reserve_slot` is absent
              when unread, by the reader's own `...(ok ? {} : {})`, so it is
              the whole condition. */}
          {vault.reserve_slot ? (
            <p className="label mono">
              <Ed x="the vault's reserve slot holds" p="the vault's second slot holds" />{" "}
              <span className="num">{vault.reserve_slot}</span>{" "}
              {/* A zero address is the only value that means "no venue". Any
                  other would be a venue this panel has not described, so it
                  says which it got rather than assuming. */}
              {slotIsEmpty(vault.reserve_slot) ? (
                <span className="chip chip-teal chip-wrap">
                  <Ed x="no venue, which is the honest answer" p="nothing, which is the honest answer" />
                </span>
              ) : (
                <span className="chip chip-gold chip-wrap">
                  <Ed x="a venue is wired that this panel has not described" p="something is wired here that this page has not explained" />
                </span>
              )}
            </p>
          ) : null}
          {/* GATE TWO, read from the same policy tuple the meter prints. Shown
              next to the slot because both are ours: a sleeve has to be wired
              AND the sweep has to send it something, and today neither is. */}
          {reserveShare === null ? null : (
            <p className="label mono">
              <Ed x="policy sends it" p="the rules send it" />{" "}
              <span className="num">{(reserveShare / 100).toFixed(0)}</span>
              {"% "}
              <Ed x="of every sweep" p="of the spare money" />{" "}
              {reserveShare === 0 ? (
                <span className="chip chip-gold chip-wrap">
                  <Ed
                    x="so nothing would reach it even if the door opened"
                    p="so nothing would reach it even if the door opened"
                  />
                </span>
              ) : null}
            </p>
          )}
          <Ed
            as="p"
            className="muted"
            style={{ fontSize: "var(--t-3)", marginTop: "var(--s-3)", maxWidth: "var(--measure)" }}
            x="The vault holds a zero address rather than a stand-in: a mock venue would have printed a number. The share is ours to move; the allowlist is not."
            p="The vault holds nothing there rather than a stand-in. A fake one would have shown a number here."
          />
        </>
      ) : null}
    </section>
  );
}
