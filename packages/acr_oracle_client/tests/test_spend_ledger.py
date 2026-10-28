"""``SpendLedger`` pages Arc for ``Spent`` events and refuses to under-report.

The fixture beside this file is FIVE REAL LOGS, pulled from Arc testnet on
2026-10-28 (``PolicyWallet`` 0xa67F1887…, blocks 67,692,989-67,693,262 — the
recordable demo's own three-rung spend ladder, including ``spendApproved``
0x78853b85… at 67,693,262). They are decoded here through web3's own
``get_event_data`` against the real ABI, so the decode path is exercised on
chain bytes without a network call.

The test that matters most is ``test_a_shrink_costs_requests_not_coverage``.
``ArcSource`` halves an over-wide range and keeps only the recent half, which for
an audit is a silent lie; this asserts the opposite behaviour explicitly, because
a regression there would still look like a passing read.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from acr_oracle_client.policy import POLICY_ABI
from acr_oracle_client.spend_ledger import (
    MIN_WINDOW,
    LedgerUnreadable,
    Reach,
    SpendLedger,
)
from web3 import Web3

WALLET = "0xa67F188746f479A9d93D112BeeB7aadB90bE834b"
RAW = json.loads((Path(__file__).parent / "fixtures" / "policy_spent_testnet.json").read_text())

#: What the five logs are known to say, asserted independently of the decoder.
EXPECTED = [
    (67_692_989, 0.010000, False, 0.010000),
    (67_693_084, 0.069463, True, 0.079463),
    (67_693_217, 0.069463, True, 0.148926),
    (67_693_250, 0.010000, False, 0.158926),
    (67_693_262, 0.069463, True, 0.228389),
]


def _decoded_fixture() -> list:
    """The raw logs, decoded by web3 exactly as a live read would decode them."""
    from web3._utils.events import get_event_data

    abi = next(a for a in POLICY_ABI if a.get("type") == "event" and a["name"] == "Spent")
    w3 = Web3()
    out = []
    for entry in RAW:
        e = dict(entry)
        e["topics"] = [Web3.to_bytes(hexstr=t) for t in e["topics"]]
        e["blockNumber"] = int(e["blockNumber"], 16)
        e["logIndex"] = int(e["logIndex"], 16)
        e["transactionIndex"] = int(e["transactionIndex"], 16)
        out.append(get_event_data(w3.codec, abi, e))
    return out


class _Event:
    """Stands in for ``contract.events.Spent()``.

    Serves the fixture to any window that overlaps it, and can be told to fail a
    given number of times first — which is how the retry and shrink paths are
    driven without a flaky chain.
    """

    def __init__(self, logs, *, fail_times: int = 0, fail_with: str = "", max_span: int | None = None):
        self.logs = logs
        self.fail_times = fail_times
        self.fail_with = fail_with
        self.max_span = max_span
        self.calls: list[tuple[int, int]] = []

    def get_logs(self, from_block: int, to_block: int):
        self.calls.append((from_block, to_block))
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError(self.fail_with)
        if self.max_span is not None and (to_block - from_block + 1) > self.max_span:
            raise RuntimeError("{'code': -32012, 'message': 'requested range too large'}")
        return [x for x in self.logs if from_block <= int(x["blockNumber"]) <= to_block]


def _ledger(event, **kw) -> SpendLedger:
    class _Client:
        rpc_url = "https://rpc.testnet.arc.io"
        wallet_address = WALLET

        def web3(self):
            return object()

    led = SpendLedger(_Client(), sleep=lambda _s: None, **kw)
    led._event = lambda: event  # type: ignore[method-assign]
    return led


# --- decoding real chain bytes ------------------------------------------------


def test_decodes_the_five_real_testnet_spends():
    spends, reach = _ledger(_Event(_decoded_fixture())).spends(67_690_000, 67_694_999)
    assert [(s.block, round(s.amount_usdc, 6), s.owner_approved, round(s.spent_in_period_usdc, 6))
            for s in spends] == EXPECTED
    assert reach == Reach(67_690_000, 67_694_999, 1, 5_000, 0)


def test_the_ladder_is_visible_from_chain_alone():
    """Two rungs, told apart by ``ownerApproved`` with no help from our records."""
    spends = _ledger(_Event(_decoded_fixture())).spends(67_690_000, 67_694_999)[0]
    assert [s.owner_approved for s in spends] == [False, True, True, False, True]
    # Every cap is the same budget, and utilisation only ever climbs.
    assert {s.cap_usdc for s in spends} == {5.0}
    util = [s.utilisation for s in spends]
    assert util == sorted(util)
    assert spends[-1].headroom_usdc == pytest.approx(5.0 - 0.228389)


def test_every_spend_carries_a_non_zero_decision_hash():
    """The contract rejects a zero hash, so a decoded zero means a decode bug."""
    spends = _ledger(_Event(_decoded_fixture())).spends(67_690_000, 67_694_999)[0]
    zero = "0x" + "00" * 32
    assert all(s.decision_hash != zero for s in spends)
    assert len({s.decision_hash for s in spends}) == 5  # replay protection holds
    assert all(s.tx.startswith("0x") and len(s.tx) == 66 for s in spends)


# --- reach --------------------------------------------------------------------


def test_pages_forward_and_covers_the_whole_range():
    ev = _Event(_decoded_fixture())
    spends, reach = _ledger(ev, window=1_000).spends(67_690_000, 67_694_999)
    assert len(spends) == 5
    assert reach.pages == 5 and reach.blocks == 5_000
    # Contiguous, no gaps, no overlaps.
    assert ev.calls[0][0] == 67_690_000 and ev.calls[-1][1] == 67_694_999
    # A list against its own tail, so the lengths differ by one on purpose.
    for (_, prev_hi), (next_lo, _) in zip(ev.calls, ev.calls[1:], strict=False):
        assert next_lo == prev_hi + 1


def test_a_shrink_costs_requests_not_coverage():
    """The whole reason this class exists rather than reusing ``ArcSource``.

    The node refuses anything over 2,000 blocks. A narrowing reader would keep
    the most recent 2,000 and report five spends it happened to still see; this
    must re-page the entire 10,000 and prove it.
    """
    ev = _Event(_decoded_fixture(), max_span=2_000)
    spends, reach = _ledger(ev, window=5_000).spends(67_690_000, 67_699_999)
    assert len(spends) == 5
    assert reach.shrinks >= 1 and reach.window <= 2_000
    assert reach.blocks == 10_000
    served = [c for c in ev.calls if (c[1] - c[0] + 1) <= 2_000]
    assert served[0][0] == 67_690_000, "the oldest blocks were never asked for"
    assert served[-1][1] == 67_699_999
    covered = 0
    for lo, hi in served:
        covered += hi - lo + 1
    assert covered == 10_000, f"only {covered} of 10,000 blocks were actually read"


def test_a_throttle_is_retried_on_the_same_range():
    ev = _Event(_decoded_fixture(), fail_times=2, fail_with="429 Too Many Requests")
    spends, _ = _ledger(ev).spends(67_690_000, 67_694_999)
    assert len(spends) == 5
    assert {c for c in ev.calls} == {(67_690_000, 67_694_999)}  # never narrowed


def test_a_transient_internal_error_is_retried_not_fatal():
    """Measured on the first live run: Arc returned ``-32603 internal error`` for
    a range a raw curl answered seconds earlier, and answered it on retry."""
    ev = _Event(_decoded_fixture(), fail_times=1,
                fail_with="{'code': -32603, 'message': 'internal error'}")
    spends, _ = _ledger(ev).spends(67_690_000, 67_694_999)
    assert len(spends) == 5


# --- refusing to under-report -------------------------------------------------


def test_an_unreadable_range_raises_rather_than_reporting_none():
    ev = _Event(_decoded_fixture(), fail_times=99, fail_with="429 slow down")
    with pytest.raises(LedgerUnreadable) as e:
        _ledger(ev, attempts=3).spends(67_690_000, 67_694_999)
    assert "unread after 3 attempts" in str(e.value)


def test_refusal_at_the_window_floor_names_the_floor():
    ev = _Event(_decoded_fixture(), max_span=1)  # nothing sane will answer
    with pytest.raises(LedgerUnreadable) as e:
        _ledger(ev, window=5_000).spends(67_690_000, 67_694_999)
    assert str(MIN_WINDOW) in str(e.value)


def test_no_wallet_and_no_connection_are_distinct_refusals():
    class _NoWallet:
        rpc_url = "x"
        wallet_address = ""

        def web3(self):
            return object()

    class _NoChain:
        rpc_url = "https://rpc.testnet.arc.io"
        wallet_address = WALLET

        def web3(self):
            return None

    with pytest.raises(LedgerUnreadable, match="no wallet address"):
        SpendLedger(_NoWallet()).spends(0, 1)
    with pytest.raises(LedgerUnreadable, match="no connection"):
        SpendLedger(_NoChain()).spends(0, 1)


def test_an_inverted_range_is_a_refusal_not_an_empty_answer():
    with pytest.raises(LedgerUnreadable, match="empty range"):
        _ledger(_Event([])).spends(100, 50)
