"""The hedger's public state — derived from public data, and honest about gaps.

Hermetic: a fake reader stands in for the chain, so these run with no RPC, no
Circle credentials and no agent wallet.
"""

from __future__ import annotations

import pytest
from index_api import hedger

AGENT = "0x1dc707e330d7b1cd9b2d0a0c0346ce2d19d35bc9"
PAYER = "0x71e140d9540d3163ead1591f81b454c6d5bd26c0"


class _Client:
    def __init__(self, position=None, collateral=0.0):
        self._position = position
        self._collateral = collateral

    def position_of(self, sid, who):
        return self._position

    def collateral_of(self, sid, who):
        return self._collateral


class _Futures:
    def __init__(self, trades=None, desk=None, client=None):
        self._trades = trades or []
        self._desk = desk
        self._client = client or _Client()

    def recent_trades(self):
        return self._trades

    def read_desk(self, index_id, **kw):
        return self._desk


def _fill(taker: str, tx: str = "0xabc") -> dict:
    return {"series_id": 3, "taker": taker, "qty": 1.0, "side": "buy",
            "mark": 0.5, "block": 1, "tx": tx, "seen_at": 0.0}


@pytest.fixture(autouse=True)
def _agent_env(monkeypatch):
    monkeypatch.setenv("ACR_HEDGER_ADDRESS", AGENT)
    monkeypatch.setenv("ACR_HEDGER_PAYER", PAYER)


def test_unconfigured_reports_itself_rather_than_inventing_an_agent(monkeypatch):
    """A deployment with no agent must say so. An empty-but-configured-looking
    panel would claim an autonomous trader that does not exist."""
    monkeypatch.delenv("ACR_HEDGER_ADDRESS", raising=False)
    state = hedger.build_hedger_state(_Futures())
    assert state["configured"] is False
    assert state["agent"] is None and state["fills"] == []


def test_only_this_agents_fills_are_counted():
    """The tape carries every trader's fills. Attributing someone else's trade
    to the agent would overstate exactly the thing this panel exists to show."""
    mine, theirs = _fill(AGENT.upper(), "0x1"), _fill("0xdead" + "0" * 36, "0x2")
    state = hedger.build_hedger_state(_Futures(trades=[mine, theirs]))
    assert [f["tx"] for f in state["fills"]] == ["0x1"], "matched on a case-sensitive address"


def test_spend_is_attributed_to_the_backing_eoa_not_the_smart_account():
    """The agent's TWO identities, and the reason this is easy to get wrong: the
    settlement records the backing EOA (EIP-3009 needs an ecrecover-able
    signature) while the trade records the smart account. Matching the ledger on
    the smart account would report a paying agent as having paid nothing."""
    receipts = {"receipts": [
        {"payer": PAYER, "amount_usdc": 0.0001},
        {"payer": PAYER, "amount_usdc": 0.0001},
        {"payer": "0x784e" + "0" * 36, "amount_usdc": 0.0001},  # a different buyer
    ]}
    state = hedger.build_hedger_state(_Futures(), receipts)
    assert state["paid_queries"] == 2
    assert state["spent_usdc"] == pytest.approx(0.0002)


def test_an_unread_ledger_is_unknown_not_zero():
    """`0 paid` and `we did not look` are different claims. Reporting the second
    as the first is the failure this codebase keeps meeting."""
    state = hedger.build_hedger_state(_Futures())
    assert state["paid_queries"] is None
    assert state["spent_usdc"] is None


def test_a_throttled_collateral_read_stays_unknown():
    """`collateral_of` returning None means the chain would not say. Flattening
    that to 0.0 would show a funded agent as broke."""
    fut = _Futures(desk={"series_id": 3}, client=_Client(collateral=None))
    state = hedger.build_hedger_state(fut)
    assert state["collateral_usdc"] is None


def test_the_gap_is_the_decision():
    """The panel shows mandate minus reality; computing it server-side keeps the
    UI from re-deriving it and drifting from what the agent itself used."""
    fut = _Futures(desk={"series_id": 3}, client=_Client(position={"contracts": 1.81}))
    state = hedger.build_hedger_state(fut)
    assert state["position_contracts"] == 1.81
    assert state["gap_contracts"] == pytest.approx(hedger.TARGET_CONTRACTS - 1.81)


def test_no_position_means_no_gap_rather_than_a_full_one():
    """An unread position with a computed gap would tell the agent to trade the
    whole mandate on the strength of a failed read."""
    fut = _Futures(desk={"series_id": 3}, client=_Client(position=None))
    state = hedger.build_hedger_state(fut)
    assert state["position_contracts"] is None and state["gap_contracts"] is None
