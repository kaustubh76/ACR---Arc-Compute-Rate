"""The autonomous hedger's public state, derived entirely from public data.

``scripts/hedger.py`` runs wherever an operator runs it — a laptop, a dispatched
workflow — and writes its decision log there. None of that is reachable from
this service, and shipping a log file around would make the Terminal's picture
depend on a file nobody can verify.

So this derives the whole thing from what anyone can already check: the agent's
position and collateral on the venue, the ``Traded`` events whose taker is the
agent, and the x402 receipts whose payer is the agent. A reader can reproduce
every number here from the chain and the public ledger, which is the only kind
of claim this project makes.

Two addresses, one agent — the detail that trips people up (docs/WALLETS.md):

* the **SCA** (``ACR_HEDGER_ADDRESS``) is what ``ACRFutures.trade`` records as
  the taker, because it reads ``msg.sender``;
* the **backing EOA** (``ACR_HEDGER_PAYER``) is what the x402 settlement
  records, because EIP-3009 needs a signature ``ecrecover`` can verify and
  Circle signs with that EOA.

Both are the same agent. Unset either and the surface honestly reports itself
as not configured rather than inventing an empty agent.
"""

from __future__ import annotations

import os

from acr_core import get_settings

#: The mandate, in contracts — the position the agent is trying to hold. Mirrors
#: HEDGER_TARGET in scripts/hedger.py; the Terminal shows it so a reader can see
#: what the agent was aiming at, not just where it ended up.
TARGET_CONTRACTS = float(os.environ.get("HEDGER_TARGET", "2.0"))
HEDGER_INDEX = os.environ.get("HEDGER_INDEX", "ACR-INF")


def _addr(name: str) -> str:
    v = (os.environ.get(name, "") or "").strip()
    return "" if v.startswith("#") else v


def _checksum(address: str) -> str:
    """EIP-55 form. Circle only ever returns lowercase and web3 refuses it."""
    try:
        from eth_utils import to_checksum_address

        return to_checksum_address(address)
    except Exception:
        return address


def build_hedger_state(futures, receipts: dict | None = None) -> dict:
    """The agent's live standing: mandate, position, fills, and what it paid.

    ``futures`` is a :class:`~index_api.onchain.FuturesReader` (cached, so this
    stays off the RPC hot path). ``receipts`` is the settlement ledger dict from
    :func:`~index_api.marketplace.build_receipts`; omitted → the spend figures
    report as unknown rather than zero, because an unread ledger is not an
    unpaid one.
    """
    sca = _addr("ACR_HEDGER_ADDRESS")
    payer = _addr("ACR_HEDGER_PAYER")
    s = get_settings()

    out: dict = {
        "configured": bool(sca),
        "agent": sca or None,
        "payer": payer or None,
        "index_id": HEDGER_INDEX,
        "target_contracts": TARGET_CONTRACTS,
        "venue": s.futures_address or None,
        "wallet_kind": "circle-agent-wallet",
        "position_contracts": None,
        "collateral_usdc": None,
        "series_id": None,
        "fills": [],
        "paid_queries": None,
        "spent_usdc": None,
    }
    if not sca:
        return out

    low = sca.lower()
    # Fills first: they need no configuration beyond the venue and they are the
    # part a reader is most likely to check against the explorer.
    try:
        trades = futures.recent_trades()
    except Exception:  # pragma: no cover - live chain
        trades = []
    out["fills"] = [t for t in trades if str(t.get("taker", "")).lower() == low][:10]

    try:
        from acr_oracle_client.futures import collateral_or_none

        desk = futures.read_desk(HEDGER_INDEX)
        sid = desk.get("series_id") if desk else None
        out["series_id"] = sid
        if sid is not None:
            # The position/collateral reads live on the client, not the reader —
            # same seam desk.py uses. Addresses are checksummed at the boundary
            # because Circle hands back lowercase and web3 refuses it, a failure
            # that presents as a throttled venue rather than a format problem.
            client = futures._client
            who = _checksum(sca)
            pos = client.position_of(sid, who)
            if pos is not None:
                out["position_contracts"] = pos.get("contracts")
            # `or 0` here would turn a throttled read into an empty account, and
            # those call for opposite conclusions. None stays None.
            out["collateral_usdc"] = collateral_or_none(client, sid, who, tries=2)
    except Exception:  # pragma: no cover - live chain
        pass

    if receipts and payer:
        rows = [
            r for r in (receipts.get("receipts") or [])
            if str(r.get("payer", "")).lower() == payer.lower()
        ]
        out["paid_queries"] = len(rows)
        out["spent_usdc"] = round(sum(float(r.get("amount_usdc", 0.0)) for r in rows), 6)

    # The gap is the whole decision: mandate minus reality. Computed here so the
    # UI never has to re-derive it and drift from what the agent itself used.
    if out["position_contracts"] is not None:
        out["gap_contracts"] = round(TARGET_CONTRACTS - float(out["position_contracts"]), 4)
    else:
        out["gap_contracts"] = None
    return out
