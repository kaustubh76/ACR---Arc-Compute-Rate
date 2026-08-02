#!/usr/bin/env python
"""Keep the live ACR futures book moving — a bounded, mean-reverting taker loop.

Trades the seeded series on a timer so the public desk (arc-compute-rate.vercel.app
/curve) shows a *living* market: inventory oscillating, open interest changing.
Only the TAKER trades — every fill auto-mirrors the maker — so one funded key
drives the whole book.

    ACR_FUTURES_ADDRESS=0x… ACR_ORACLE_ADDRESS=0x… TAKER_PRIVATE_KEY=0x… \
    LOOP_INTERVAL=120 LOOP_DURATION=4h LOOP_MAX_TRADES=100 LOOP_BAND=4 \
    uv run python scripts/futures_loop.py            # add --once for a single trade

Safety rails (cannot drain the wallet, breach margin, or run away):
  • mean-reverting qty, hard-clamped to a band that stays inside posted margin
  • gas-floor stop • max-trades + max-duration caps • per-iteration try/except
"""

from __future__ import annotations

import os
import random
import sys
import time

from acr_oracle_client import FuturesClient, OracleClient, select_series_for_index
from acr_oracle_client.futures import _rpc_retry

RPC = os.environ.get("ACR_ARC_RPC_URL", "https://rpc.testnet.arc.network")
FUTURES = os.environ.get("ACR_FUTURES_ADDRESS", "")
ORACLE = os.environ.get("ACR_ORACLE_ADDRESS", "0x4f00e3BDd224F4c4b4958D54cD774E84B9092609")
INDEX = os.environ.get("SEED_INDEX", "ACR-INF")
INTERVAL = float(os.environ.get("LOOP_INTERVAL", "120"))
MAX_TRADES = int(os.environ.get("LOOP_MAX_TRADES", "100"))
BAND = int(os.environ.get("LOOP_BAND", "4"))
GAS_FLOOR = float(os.environ.get("GAS_FLOOR", "1.0"))  # native USDC; stop below this
#: Posted when the taker has no stake on the selected series (i.e. after a roll).
LOOP_COLLATERAL = float(os.environ.get("LOOP_COLLATERAL", "3.0"))
#: How many times `--once` will try before reporting the tick as failed. Arc's
#: public RPC 429s routinely, and with escalating backoff (5s, 10s, …) five
#: attempts stay well inside the heartbeat job's timeout.
ONCE_ATTEMPTS = int(os.environ.get("LOOP_ONCE_ATTEMPTS", "5"))
MARGIN_SAFETY = 0.85  # only use 85% of margin headroom when clamping the band

_MARGIN_ABI = [{"type": "function", "name": "MARGIN_BPS", "stateMutability": "view",
                "inputs": [], "outputs": [{"name": "", "type": "uint256"}]}]


def _parse_duration(s: str) -> float:
    s = s.strip().lower()
    mult = {"h": 3600, "m": 60, "s": 1}.get(s[-1:], 1)
    return float(s[:-1]) * mult if s[-1:] in "hms" else float(s)


DURATION = _parse_duration(os.environ.get("LOOP_DURATION", "4h"))


def choose_qty(inv: float, band: int) -> int:
    """A mean-reverting step: small magnitude, biased toward flat, hard-clamped so
    the resulting inventory never leaves [-band, band] (so margin never breaks)."""
    mag = random.choice([1, 1, 2])
    p_sell = 0.72 if inv > 0 else 0.28 if inv < 0 else 0.5
    qty = -mag if random.random() < p_sell else mag
    new = inv + qty
    if new > band:
        qty = int(band - inv)
    elif new < -band:
        qty = int(-band - inv)
    if qty == 0:  # at the edge — force a minimal reverting step back toward flat
        if inv > 0:
            qty = -1
        elif inv < 0:
            qty = 1
        else:
            qty = random.choice([-1, 1])
    return int(qty)


def _read_collateral(fc, sid: int, address: str, tries: int = 4) -> float | None:
    """This wallet's collateral on ``sid``, or **None if the chain would not
    say**. The distinction is the whole point: a read that failed and a balance
    that is genuinely zero call for opposite actions — wait, versus spend."""
    for attempt in range(1, tries + 1):
        try:
            v = fc.collateral_of(sid, address)
        except Exception:
            v = None
        if v is not None:
            return float(v)
        if attempt < tries:
            time.sleep(3.0 * attempt)
    return None


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)  # observable: flush each line to the log
    once = "--once" in sys.argv
    taker_key = os.environ.get("TAKER_PRIVATE_KEY", "")
    if not (FUTURES and taker_key):
        print("set ACR_FUTURES_ADDRESS + TAKER_PRIVATE_KEY")
        sys.exit(1)

    from eth_account import Account
    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 15}))
    if not w3.is_connected():
        print("Arc RPC unreachable")
        sys.exit(1)
    taker = Account.from_key(taker_key)

    fc = FuturesClient(rpc_url=RPC, futures_address=FUTURES, private_key=taker_key)
    oracle = OracleClient(rpc_url=RPC, oracle_address=ORACLE)
    margin_c = w3.eth.contract(address=w3.to_checksum_address(FUTURES), abi=_MARGIN_ABI)
    try:
        margin_bps = int(_rpc_retry(margin_c.functions.MARGIN_BPS().call))
    except Exception:
        margin_bps = 2000

    # select_series_for_index returns the newest UNSETTLED series, which past
    # expiry is a dead one: every trade would revert "expired" and the loop
    # would report success having done nothing. Filter on life, not settlement.
    now = _rpc_retry(lambda: w3.eth.get_block("latest"))["timestamp"]
    live = [x for x in fc.read_all_series() if x["expiry_ts"] > now]
    series = select_series_for_index(live, INDEX)
    if series is None:
        print(f"no LIVE series for {INDEX} — it may have expired; run `make futures-roll`")
        sys.exit(1)
    sid, mult = series["series_id"], series["multiplier"]

    def native_bal() -> float:
        return _rpc_retry(w3.eth.get_balance, taker.address) / 1e18

    # A taker with no collateral joins the roster (consuming a MAX_TRADERS slot)
    # and then reverts on every trade. Collateral is PER SERIES, so this is the
    # normal state right after a roll — the stake sits on the retired series.
    # Self-provision rather than requiring a human after every roll, which would
    # make the lifecycle automation a lie; refuse only when it truly can't.
    # A THROTTLED READ IS NOT ZERO. `collateral_of` returns None when the RPC
    # refuses, and `None or 0.0` used to flatten that into "no collateral" —
    # so a 429 made this decide to spend LOOP_COLLATERAL that was already
    # posted. It happened: the taker held 3.00 USDC on series 1 and the
    # heartbeat announced "no collateral (new series?)" and tried to post 3.00
    # more. The post 429'd too, which is the only reason no money moved. The
    # tick loop below has always drawn this distinction ("don't trade on
    # assumed-zero"); the provisioning path must draw it before spending.
    taker_collateral = _read_collateral(fc, sid, taker.address)
    if taker_collateral is None:
        print(f"  ⏹ could not read collateral on series {sid} after retries — refusing to "
              "post a stake that may already be there")
        sys.exit(1)
    if taker_collateral <= 0:
        free = native_bal()
        want = min(LOOP_COLLATERAL, free - GAS_FLOOR)
        if want < 0.5:
            print(f"taker {taker.address} has no collateral on series {sid} and only "
                  f"{free:.2f} USDC free (needs {LOOP_COLLATERAL} + {GAS_FLOOR} gas floor) — "
                  f"fund it, or check TAKER_PRIVATE_KEY matches the funded taker")
            sys.exit(1)
        print(f"  · no collateral on series {sid} (new series?) — posting {want:.2f} USDC")
        # Retry the write for the same reason the tick loop retries: Arc 429s
        # routinely, and a heartbeat that goes red on the first flake is red
        # most hours, which teaches everyone to ignore it.
        posted = False
        for attempt in range(1, ONCE_ATTEMPTS + 1):
            try:
                fc.post_collateral(sid, want)
                posted = True
                break
            except Exception as exc:
                print(f"  · post attempt {attempt}/{ONCE_ATTEMPTS} failed — {str(exc)[:90]}")
                if attempt < ONCE_ATTEMPTS:
                    time.sleep(5.0 * attempt)
        if not posted:
            print("  ✗ could not post collateral after retries")
            sys.exit(1)
        landed = _read_collateral(fc, sid, taker.address)
        if not landed:
            print("  ✗ collateral did not land — refusing to trade into a margin revert")
            sys.exit(1)
        taker_collateral = landed
    print(f"  loop → series {sid} ({INDEX}, mult {mult}), taker {taker.address[:10]}…, "
          f"band ±{BAND}, every {INTERVAL:.0f}s, margin {margin_bps}bps")

    start = time.monotonic()
    done = 0
    fails = 0  # consecutive tick failures — only a long run of them stops the loop
    while done < MAX_TRADES and (time.monotonic() - start) < DURATION:
        try:
            # The ENTIRE tick (incl. the gas + on-chain reads) is guarded, so a
            # transient RPC 429 skips a tick — it never kills the loop.
            gas = native_bal()
            if gas < GAS_FLOOR:  # a SUCCESSFUL read below the floor → genuinely done
                print(f"  ⏹ gas {gas:.3f} < floor {GAS_FLOOR} — stopping")
                break
            pos = fc.position_of(sid, taker.address)
            coll = fc.collateral_of(sid, taker.address)
            if pos is None or coll is None:  # bad read — don't trade on assumed-zero
                raise RuntimeError("position/collateral read failed")
            inv = pos["contracts"]
            mark = (oracle.read_latest(INDEX) or {}).get("value") or (series["settlement_price"] or 0.5)

            # Clamp the band to the collateral's margin headroom (never breach).
            per_contract_margin = max(mark * mult * margin_bps / 1e4, 1e-9)
            headroom = int((coll * MARGIN_SAFETY) / per_contract_margin)
            band = max(1, min(BAND, headroom))

            qty = choose_qty(inv, band)
            fc.trade(sid, float(qty))
            done += 1
            fails = 0
            side = "BUY " if qty > 0 else "SELL"
            print(f"  [{done:>3}] {side} {abs(qty)} @ {mark:.5f} → inv {inv + qty:+.0f} "
                  f"(band ±{band}) · coll ${coll:.2f} · gas {gas:.3f}")
        except Exception as exc:  # noqa: BLE001 — one bad tick shouldn't kill the loop
            fails += 1
            print(f"  · tick skipped ({fails}) — {str(exc)[:90]}")
            if fails >= 30:  # the endpoint has been down a long time — give up cleanly
                print("  ⏹ 30 consecutive RPC failures — endpoint looks down; stopping")
                break
            # `--once` means "land one fill", NOT "make at most one attempt".
            # It used to give up on the first exception, so a single Arc 429 —
            # routine on the public endpoint — failed the whole hourly
            # heartbeat. The first scheduled run did exactly that. A heartbeat
            # that cries wolf most hours teaches everyone to ignore it, which
            # costs more than the outage it was meant to announce.
            if once and fails >= ONCE_ATTEMPTS:
                print(f"  ⏹ {fails} attempts, all failed — giving up this tick")
                break
            time.sleep(min(60.0, 5.0 * fails))  # escalating backoff while the RPC is unhappy
            continue

        if once:
            break
        time.sleep(INTERVAL + random.uniform(0, min(20.0, INTERVAL * 0.15)))

    print(f"  done — {done} trades over {(time.monotonic() - start) / 60:.1f} min")
    # A heartbeat that beat zero times must not report success. `--once` can
    # exhaust its attempts without landing a fill, so without this the workflow
    # goes green while the book has stopped moving — the worst kind of green.
    if once and done == 0:
        print("  ✗ heartbeat traded nothing — failing so the run is visibly red")
        sys.exit(1)


if __name__ == "__main__":
    main()
