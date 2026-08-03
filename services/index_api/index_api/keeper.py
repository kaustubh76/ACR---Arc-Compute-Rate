"""The venue keeper, running where the credentials already are.

The heartbeat trade and the series roll used to run in GitHub Actions from raw
private keys. Now that the venue signs through Circle custody, the same jobs in
CI would need ``ACR_CIRCLE_ENTITY_SECRET`` — a credential that controls **every**
developer-controlled wallet, including the one that signs oracle prints. That is
a strictly larger blast radius than the scoped key it would replace, so moving
the jobs to CI's credential is the wrong direction. Move the jobs instead.

This service already holds those credentials, already runs a 60-second loop, and
already posts hourly prints with them. Adding the venue's two chores here means
**no signing credential in CI at all** — see docs/WALLETS.md.

Three rules this module lives by, because it shares a process with the press:

1. **It can never take the press down.** Every entry point is wrapped by the
   caller and every failure is swallowed after logging. A venue that stops
   trading is a degraded demo; a press that stops printing is a dead product,
   and the contract will not settle against a stale print.
2. **It does nothing without custody.** If the maker/taker roles do not resolve
   to Circle wallets it returns immediately rather than reaching for an ambient
   key — the exact fallback that kept the venue on a raw EOA for weeks.
3. **Cooldowns bound every write.** A failing chore retried each 60s tick would
   burn gas and RPC budget to keep failing.

``ACR_KEEPER=0`` disables the whole thing without a deploy.
"""

from __future__ import annotations

import logging
import os
import time

from acr_core import get_settings

log = logging.getLogger("index_api.keeper")

#: One tick an hour, matching the cron this replaces. Not tied to the warm
#: loop's cadence: the warm loop is a read, and this spends money.
HEARTBEAT_EVERY_S = float(os.environ.get("ACR_KEEPER_HEARTBEAT_S", "3600"))
#: The roll only needs to be *considered* often; futures_roll no-ops while a
#: collateralized series has life left, so this is cheap when there is nothing
#: to do — one read, no write.
ROLL_CHECK_EVERY_S = float(os.environ.get("ACR_KEEPER_ROLL_S", "1800"))
#: Below this the keeper stands down rather than half-completing a chore. On Arc
#: USDC is gas, so a wallet spent to the floor cannot even withdraw.
GAS_FLOOR_USDC = float(os.environ.get("ACR_KEEPER_GAS_FLOOR", "1.0"))
#: How much a heartbeat trade moves. Small on purpose: the point is a live tape,
#: not a position.
TRADE_QTY = float(os.environ.get("ACR_KEEPER_QTY", "0.25"))
INDEX = os.environ.get("ACR_KEEPER_INDEX", os.environ.get("SEED_INDEX", "ACR-INF"))
#: What a roll posts as maker collateral. Mirrors scripts/futures_roll.py so the
#: two paths cannot disagree about what a healthy successor looks like.
ROLL_COLLATERAL = float(os.environ.get("ROLL_COLLATERAL", "1.5"))
#: The collateral token — Arc's native USDC predeploy, also a standard ERC-20.
USDC_ADDRESS = os.environ.get(
    "ACR_USDC_ADDRESS", "0x3600000000000000000000000000000000000000"
)

_OWNER_ABI = [
    {"type": "function", "name": "owner", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "address"}]},
]

_last_heartbeat = 0.0
_last_roll_check = 0.0


def enabled() -> bool:
    return os.environ.get("ACR_KEEPER", "1") not in ("0", "false", "no")



def may_open_series(owner: str, me: str) -> bool:
    """Whether ``me`` is allowed to call ``openSeries``.

    Trivial, and extracted anyway: it is the difference between a roll and a
    transaction that reverts on every cooldown forever. Until 2026-08-03 the
    venue's owner was the retiring EOA and this was always False, so the keeper
    could only shout for a human; the handover to the maker's own Circle wallet
    is what made an unattended roll possible. The guard has to survive that
    changing back — a fork, a redeploy pointed elsewhere, another transfer.
    """
    return bool(owner) and bool(me) and str(owner).lower() == str(me).lower()


def roll_budget_ok(gas_usdc: float) -> bool:
    """Whether one wallet can afford BOTH the collateral and the gas.

    On Arc they come out of the same balance, so checking them separately is
    how you open a series you then cannot collateralize — and an
    uncollateralized series is a desk that looks live and reverts on first
    contact, which is worse than no roll at all.
    """
    return gas_usdc >= GAS_FLOOR_USDC + ROLL_COLLATERAL


def _custody_signer(role: str):
    """The role's signer, but ONLY if it is Circle custody.

    Returning a local-key signer here would quietly reintroduce the thing this
    module exists to remove, and it would do it on a host that has an ambient
    ``ACR_POSTER_PRIVATE_KEY`` lying around in some deployments.
    """
    from acr_oracle_client import build_role_signer

    sg = build_role_signer(role, get_settings())
    return sg if sg is not None and type(sg).__name__ == "CircleWalletSigner" else None


def heartbeat_once(futures) -> str | None:
    """One mean-reverting taker fill, so the public tape keeps moving.

    Returns a short verdict for the log, or None when it did nothing. Sized
    against the desk's own ``feasible_qty`` so it can never ask for a fill the
    contract would revert — the same clamp a reader gets.
    """
    global _last_heartbeat
    if not enabled():
        return None
    now = time.time()
    if now - _last_heartbeat < HEARTBEAT_EVERY_S:
        return None

    signer = _custody_signer("taker")
    if signer is None:
        return None
    _last_heartbeat = now

    from acr_oracle_client import FuturesClient, select_series_for_index
    from acr_oracle_client.futures import collateral_or_none

    from .desk import feasible_qty

    s = get_settings()
    fc = FuturesClient(
        rpc_url=s.arc_rpc_url, futures_address=s.futures_address, signer=signer
    )
    me = signer.address
    series = select_series_for_index(fc.read_all_series(), INDEX)
    if not series or series.get("settled"):
        return "no live series"

    sid, mult = series["series_id"], series["multiplier"]
    mine = collateral_or_none(fc, sid, me)
    maker_coll = collateral_or_none(fc, sid, series["maker"])
    # A throttled read is not an empty account, and trading on the assumption
    # that it is has cost this project real money twice.
    if mine is None or maker_coll is None:
        return "chain would not say — skipped"
    if mine <= 0:
        return "no collateral on the live series — operator must provision"

    from .onchain import get_reader

    mark = (get_reader().read(INDEX) or {}).get("value")
    if not mark:
        return "no mark"
    pos = (fc.position_of(sid, me) or {}).get("contracts", 0.0)
    max_buy, max_sell = feasible_qty(
        mark, mult, 2000, mine, pos, maker_coll, series.get("maker_inventory", 0.0)
    )
    # Mean-revert around flat: sell when long, buy when short. Keeps the tape
    # alive without accumulating a position nobody asked for.
    want = -TRADE_QTY if pos > 0 else TRADE_QTY
    room = max_buy if want > 0 else max_sell
    if room <= 0:
        return "no room on the book"
    qty = round(min(abs(want), room) * (1 if want > 0 else -1), 2)
    if abs(qty) < 0.01:
        return "clamped below the minimum"
    fc.trade(sid, qty)
    return f"traded {qty:+.2f} on series {sid}"


def roll_if_needed(futures) -> str | None:
    """Open a successor series before the live one expires.

    Deliberately thin: it defers to the SAME arithmetic ``scripts/futures_roll``
    uses rather than re-deriving when a roll is due, so the cron path and this
    one can never disagree about whether the venue needs rolling.
    """
    global _last_roll_check
    if not enabled():
        return None
    now = time.time()
    if now - _last_roll_check < ROLL_CHECK_EVERY_S:
        return None
    _last_roll_check = now

    signer = _custody_signer("maker")
    if signer is None:
        return None

    from acr_oracle_client import FuturesClient
    from acr_oracle_client.futures import _rpc_retry, collateral_or_none

    s = get_settings()
    fc = FuturesClient(
        rpc_url=s.arc_rpc_url, futures_address=s.futures_address, signer=signer
    )
    min_life_h = float(os.environ.get("ROLL_MIN_LIFE_H", "72"))
    w3 = fc._connect()
    if w3 is None:
        return None
    now_chain = int(_rpc_retry(lambda: w3.eth.get_block("latest"))["timestamp"])
    for existing in fc.read_all_series():
        if existing["index_id"] != INDEX or existing["settled"]:
            continue
        hours_left = (existing["expiry_ts"] - now_chain) / 3600
        funded = collateral_or_none(fc, existing["series_id"], signer.address)
        if funded is None:
            return "collateral unreadable — refusing to roll on a guess"
        if hours_left > min_life_h and funded > 0:
            return None  # healthy; nothing to do and nothing worth logging

    # Something needs rolling.
    #
    # `openSeries` is onlyOwner, and until 2026-08-03 the owner was the retiring
    # EOA — a key this process does not hold and should not — so this could only
    # shout for a human. Ownership now sits with the maker's own Circle wallet
    # (verified on-chain: owner 0x9D44A7Dd…, pendingOwner zero), which is what
    # makes an unattended roll possible at all.
    gas = _rpc_retry(w3.eth.get_balance, w3.to_checksum_address(signer.address)) / 1e18
    # Collateral AND gas come out of one balance on Arc, so check for both up
    # front rather than opening a series we then cannot collateralize — an
    # uncollateralized series is a desk that looks live and reverts on first
    # contact, which is worse than no roll at all.
    if not roll_budget_ok(gas):
        return (f"maker holds {gas:.2f} USDC; a roll needs {ROLL_COLLATERAL:.2f} "
                f"collateral + {GAS_FLOOR_USDC:.2f} gas floor — standing down")

    owner = _rpc_retry(
        w3.eth.contract(
            address=w3.to_checksum_address(s.futures_address), abi=_OWNER_ABI
        ).functions.owner().call
    )
    if not may_open_series(owner, signer.address):
        # Not ours to open. Refuse loudly instead of sending a transaction that
        # reverts and burns gas every cooldown.
        return f"ROLL DUE but the venue is owned by {owner} — run `make futures-roll`"

    expiry = now_chain + int(float(os.environ.get("ROLL_EXPIRY_DAYS", "14")) * 86400)
    fc.open_series(INDEX, expiry, int(os.environ.get("ROLL_MULT", "10")), signer.address)
    series = fc.read_all_series()
    sid = len(series) - 1

    # Post collateral, or the successor is a series nobody can trade into.
    allowance = fc.allowance_units(USDC_ADDRESS, signer.address)
    if allowance is not None and allowance < int(ROLL_COLLATERAL * 1_000_000):
        fc.approve_venue(USDC_ADDRESS)
        time.sleep(2)
    fc.post_collateral(sid, ROLL_COLLATERAL)

    # Assert it landed. `futures_seed` exits 0 on an uncollateralized series and
    # that is exactly the failure worth refusing to repeat here.
    posted = collateral_or_none(fc, sid, signer.address)
    if not posted:
        return f"opened series {sid} but collateral did NOT land — the desk needs a human"
    return f"rolled to series {sid} (+{os.environ.get('ROLL_EXPIRY_DAYS', '14')}d), {posted:.2f} USDC posted"
