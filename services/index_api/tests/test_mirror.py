"""Mirror-policy tests — which settlements may become public benchmark rows.

Everything this layer lets through becomes a row in a tape that cannot be edited
afterwards, so the interesting cases are all the ones it must refuse.
"""

from __future__ import annotations

from index_api.mirror import BATCH, MAX_MIRROR_LAG_S, mirror_once, mirrorable
from index_api.x402 import PaymentReceipt

NOW = 1_785_000_000.0
SELLER = "0x" + "22" * 20
PAYER = "0x" + "11" * 20


def _receipt(**over) -> PaymentReceipt:
    base = dict(
        payer=PAYER,
        amount_usdc=0.005229,
        tx_ref="ref-1",
        network="eip155:5042002",
        scheme="exact",
        settled_at=NOW - 30,
        resource="/compute/acr-seller-inf-mid-a",
        seller=SELLER,
        unit="$/1k tokens",
        quantity=0.01,
    )
    base.update(over)
    return PaymentReceipt(**base)


class _FakeClient:
    """A MirrorClient stand-in that records calls instead of spending gas."""

    def __init__(self, already: dict | None = None, fail_on: str = ""):
        self.opened: list[str] = []
        self.finalized: list[str] = []
        self._already = already or {}
        self._fail_on = fail_on

    def configured(self) -> bool:
        return True

    def state_for(self, tx_ref: str):
        return self._already.get(tx_ref)

    def open_settlement(self, tx_ref, **kw):
        if self._fail_on == "open":
            raise RuntimeError("chain said no")
        self.opened.append(tx_ref)
        return "0xopen"

    def finalize_settlement(self, tx_ref, **kw):
        if self._fail_on == "finalize":
            raise RuntimeError("chain said no")
        self.finalized.append(tx_ref)
        return "0xfinalize"


# --- the gates ---------------------------------------------------------------


def test_a_well_formed_fleet_receipt_is_mirrorable():
    assert mirrorable(_receipt(), NOW) == (True, "")


def test_a_dev_receipt_never_reaches_the_chain():
    """Invented revenue on a public counter is bad; invented settlements in a
    published benchmark are worse."""
    ok, why = mirrorable(_receipt(scheme="dev"), NOW)
    assert not ok and "real settlement" in why


def test_a_flat_platform_receipt_is_refused():
    """No seller means no unit price. Mirroring it would add volume a rating
    divides by while contributing no slippage — it would dilute every grade."""
    ok, why = mirrorable(_receipt(seller=""), NOW)
    assert not ok and "unit price" in why


def test_a_receipt_without_a_quantity_is_refused():
    ok, why = mirrorable(_receipt(quantity=0.0), NOW)
    assert not ok and "quantity" in why


def test_a_settlement_dated_into_the_future_is_refused():
    ok, why = mirrorable(_receipt(settled_at=NOW + 60), NOW)
    assert not ok and "future" in why


def test_a_settlement_past_the_mirror_window_is_refused_not_forced():
    """The contract bounds the ordinary path at an hour. Pushing an older one
    through the owner-only late path is an operator's decision, not a keeper's."""
    ok, why = mirrorable(_receipt(settled_at=NOW - MAX_MIRROR_LAG_S - 1), NOW)
    assert not ok and "late path" in why


def test_the_window_boundary_is_inclusive():
    assert mirrorable(_receipt(settled_at=NOW - MAX_MIRROR_LAG_S), NOW)[0]


# --- the sweep ---------------------------------------------------------------


def test_an_eligible_receipt_is_opened_then_finalized():
    c = _FakeClient()
    verdict = mirror_once([_receipt()], client=c, now=NOW)
    assert c.opened == ["ref-1"]
    assert c.finalized == ["ref-1"]
    assert "opened 1" in verdict and "finalized 1" in verdict


def test_an_already_open_settlement_is_only_finalized():
    """Re-running must not re-open. The contract would revert, but spending gas
    to be told what a read could have said is the keeper wasting the press's
    money every tick."""
    c = _FakeClient(already={"ref-1": {"opened": True, "finalized": False}})
    mirror_once([_receipt()], client=c, now=NOW)
    assert c.opened == []
    assert c.finalized == ["ref-1"]


def test_a_fully_mirrored_settlement_is_left_alone():
    c = _FakeClient(already={"ref-1": {"opened": True, "finalized": True}})
    assert mirror_once([_receipt()], client=c, now=NOW) is None
    assert c.opened == [] and c.finalized == []


def test_one_failure_does_not_stop_the_others():
    """A chore that throws costs the press a beat."""
    c = _FakeClient(fail_on="open")
    verdict = mirror_once([_receipt(tx_ref="a"), _receipt(tx_ref="b")], client=c, now=NOW)
    assert "FAILED 2" in verdict
    assert c.finalized == []


def test_the_sweep_is_bounded_per_tick():
    c = _FakeClient()
    many = [_receipt(tx_ref=f"ref-{i}") for i in range(BATCH + 5)]
    mirror_once(many, client=c, now=NOW)
    assert len(c.opened) == BATCH


def test_a_backlog_past_the_window_is_reported_not_silently_dropped():
    """A hole in a public tape that nobody is told about reads as an absence of
    trading rather than an absence of mirroring."""
    c = _FakeClient()
    stale = _receipt(tx_ref="old", settled_at=NOW - 2 * MAX_MIRROR_LAG_S)
    verdict = mirror_once([_receipt(), stale], client=c, now=NOW)
    assert "operator late-path needed" in verdict


def test_an_unconfigured_client_stands_down_quietly():
    class _Off(_FakeClient):
        def configured(self):
            return False

    assert mirror_once([_receipt()], client=_Off(), now=NOW) is None


def test_a_receipt_for_an_unknown_resource_is_skipped():
    c = _FakeClient()
    verdict = mirror_once([_receipt(resource="/prints/ACR-INF")], client=c, now=NOW)
    # It passed `mirrorable` (it has a seller and a quantity) but no fleet
    # listing resolves it, so there is no index to benchmark it against.
    assert c.opened == []
    assert verdict is not None and "no listing" in verdict
