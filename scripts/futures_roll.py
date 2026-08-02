#!/usr/bin/env python
"""Roll the futures venue onto a fresh series — safely, and idempotently.

A series expires. When it does, ``trade`` reverts and the desk has nothing to
offer, so the venue needs a successor opened before the old one dies. This does
that, and refuses to pretend it worked when it didn't.

Why not ``scripts/futures_seed.py``: with ``SEED_FORCE_NEW=1`` it opens the
series, then throws on an ``approve`` for the configured taker key, prints a
friendly note and **exits 0** — leaving an opened, uncollateralized series
reported as success. A maker with no collateral cannot absorb a single desk
trade, so the desk looks live and reverts on first contact. This script asserts
the collateral landed and exits non-zero otherwise.

Safe to run from cron: it no-ops when a healthy series already has life left.

    MAKER_PRIVATE_KEY=0x… uv run python scripts/futures_roll.py   # == make futures-roll

    ROLL_INDEX=ACR-INF ROLL_MULT=10 ROLL_COLLATERAL=1.5 ROLL_EXPIRY_DAYS=7
    ROLL_MIN_LIFE_H=24     # below this much life left, roll
    ROLL_GAS_FLOOR=0.75    # never spend the maker below this many USDC of gas
"""

from __future__ import annotations

import os
import sys
import time

from acr_core import get_settings
from acr_oracle_client import FuturesClient
from acr_oracle_client.futures import _rpc_retry, collateral_or_none

INDEX = os.environ.get("ROLL_INDEX", "ACR-INF")
MULT = int(os.environ.get("ROLL_MULT", "10"))
COLLATERAL = float(os.environ.get("ROLL_COLLATERAL", "1.5"))
EXPIRY_DAYS = float(os.environ.get("ROLL_EXPIRY_DAYS", "7"))
MIN_LIFE_H = float(os.environ.get("ROLL_MIN_LIFE_H", "24"))
#: On Arc, USDC *is* the gas token — posted collateral comes straight out of the
#: maker's ability to pay for its next transaction. Never spend below this.
GAS_FLOOR = float(os.environ.get("ROLL_GAS_FLOOR", "0.75"))

#: The collateral token. On Arc this is the native USDC predeploy — the default
#: — but it is the venue's *configured* token, not a law of the universe, so it
#: is overridable. That is what lets this script be exercised against a real
#: deployment on anvil (see tests/test_futures_roll_onchain.py) instead of only
#: ever being run in production for the first time, which is what it was doing.
USDC_PREDEPLOY = os.environ.get(
    "ROLL_USDC_ADDRESS", "0x3600000000000000000000000000000000000000"
)
_ERC20_ABI = [
    {"type": "function", "name": "approve", "stateMutability": "nonpayable",
     "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
    {"type": "function", "name": "allowance", "stateMutability": "view",
     "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
]


def _check(ok: bool, label: str) -> bool:
    print(f"  {'✓' if ok else '✗'} {label}")
    return ok


def main() -> None:
    s = get_settings()
    maker_key = os.environ.get("MAKER_PRIVATE_KEY", "") or s.poster_private_key
    if not (s.futures_address and maker_key):
        print("set ACR_FUTURES_ADDRESS and MAKER_PRIVATE_KEY")
        sys.exit(1)

    from eth_account import Account
    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(s.arc_rpc_url, request_kwargs={"timeout": 25}))
    maker = Account.from_key(maker_key)
    fc = FuturesClient(rpc_url=s.arc_rpc_url, futures_address=s.futures_address,
                       private_key=maker_key)

    chain_id = _rpc_retry(lambda: w3.eth.chain_id)
    if not _check(chain_id == s.arc_chain_id, f"chain id {chain_id} == {s.arc_chain_id}"):
        sys.exit(1)
    print(f"  · venue {s.futures_address}, maker {maker.address}")

    # 1) Idempotence — a healthy series with life left needs no roll.
    now = int(_rpc_retry(lambda: w3.eth.get_block("latest"))["timestamp"])
    for existing in fc.read_all_series():
        if existing["index_id"] != INDEX or existing["settled"]:
            continue
        hours_left = (existing["expiry_ts"] - now) / 3600
        # A THROTTLED READ IS NOT AN UNFUNDED MAKER. `or 0` used to flatten a
        # failed read into "NONE", and the response is to open a whole new
        # series and post collateral to it. That fired for real: series 1 had
        # 147.9 HOURS of life left and a funded maker, and a 429 made this
        # roll anyway — spending 1.50 USDC on a successor nothing needed.
        funded_read = collateral_or_none(fc, existing["series_id"], maker.address)
        if funded_read is None:
            print(f"  ⏹ could not read the maker's collateral on series "
                  f"{existing['series_id']} after retries — refusing to roll on a "
                  "guess; the next run will see it")
            sys.exit(0)
        funded = funded_read > 0
        if hours_left > MIN_LIFE_H and funded:
            print(f"  ↩ series {existing['series_id']} has {hours_left:.1f}h left and is "
                  f"collateralized — nothing to roll")
            sys.exit(0)
        print(f"  · series {existing['series_id']}: {hours_left:.1f}h left, "
              f"maker collateral {'yes' if funded else 'NONE'} → rolling")

    # 2) Budget guard BEFORE any write — collateral and gas come from one balance.
    native = _rpc_retry(w3.eth.get_balance, Web3.to_checksum_address(maker.address)) / 1e18
    if not _check(
        native - COLLATERAL >= GAS_FLOOR,
        f"maker holds {native:.3f} USDC; posting {COLLATERAL:.2f} leaves "
        f"{native - COLLATERAL:.3f} ≥ {GAS_FLOOR} for gas",
    ):
        print("    top the maker up, or lower ROLL_COLLATERAL")
        sys.exit(1)

    # 3) Open. onlyOwner, and the contract itself requires a live oracle value,
    #    so a dead feed fails here rather than halfway through.
    expiry = now + int(EXPIRY_DAYS * 86400)
    fc.open_series(INDEX, expiry, MULT, maker.address)
    sid = len(fc.read_all_series()) - 1  # re-read; don't trust a receipt return
    print(f"  ① opened series {sid} ({INDEX}, mult {MULT}, expiry +{EXPIRY_DAYS:g}d)")

    # 4) Allowance, then collateral.
    usdc = w3.eth.contract(address=Web3.to_checksum_address(USDC_PREDEPLOY), abi=_ERC20_ABI)
    allowance = int(_rpc_retry(
        usdc.functions.allowance(maker.address, Web3.to_checksum_address(s.futures_address)).call
    ))
    if allowance < int(COLLATERAL * 1_000_000):
        tx = usdc.functions.approve(
            Web3.to_checksum_address(s.futures_address), 2**256 - 1
        ).build_transaction({
            "from": maker.address,
            "nonce": _rpc_retry(w3.eth.get_transaction_count, maker.address),
            "chainId": chain_id,
        })
        signed = maker.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        h = w3.eth.send_raw_transaction(raw)
        w3.eth.wait_for_transaction_receipt(h, timeout=90, poll_latency=2.0)
        print("  ② re-approved the venue on the USDC predeploy")
        time.sleep(2)  # pace the throttled Arc RPC between writes

    fc.post_collateral(sid, COLLATERAL)

    # 5) The assertion that makes this script worth having.
    posted = fc.collateral_of(sid, maker.address) or 0.0
    if not _check(posted > 0, f"maker collateral on series {sid}: {posted:.2f} USDC"):
        print("    the series is OPEN but UNCOLLATERALIZED — the desk would revert on "
              "first contact. Fix the collateral step before advertising this venue.")
        sys.exit(1)

    desk = fc.read_desk(INDEX) or {}
    print(f"  ③ desk reads back: maker inventory {desk.get('maker_inventory', 0):+.2f}, "
          f"traders {desk.get('trader_count', 0)}, expiry +{EXPIRY_DAYS:g}d")
    print("roll: DONE")


if __name__ == "__main__":
    main()
