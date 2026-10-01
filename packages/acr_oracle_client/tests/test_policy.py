"""PolicyClient — the arithmetic, and the refusals that keep a threshold real.

Hermetic: nothing here touches a chain. The claims are the ones that would be
silently wrong rather than loudly broken — an amount rounded instead of refused,
a decision hash that moves when a dict is rebuilt in another order, and an
operator holding both keys so the escalation threshold approves itself.
"""

from __future__ import annotations

import pytest
from acr_oracle_client.policy import (
    USDC,
    PolicyClient,
    category_id,
    decision_hash,
    usdc_units,
)

# --- amounts ---------------------------------------------------------------

def test_whole_and_fractional_usdc_convert_exactly():
    assert usdc_units(1) == USDC
    assert usdc_units("1.5") == 1_500_000
    assert usdc_units("0.000001") == 1
    assert usdc_units(0) == 0


def test_a_float_the_caller_typed_is_not_punished_for_being_a_float():
    """Decimal(0.1) is 0.1000000000000000055…; routing through str keeps 0.1 exact."""
    assert usdc_units(0.1) == 100_000
    assert usdc_units(12.34) == 12_340_000


def test_an_amount_finer_than_six_decimals_is_refused_not_rounded():
    """Rounding here would make the agent pay a number nobody chose."""
    with pytest.raises(ValueError, match="finer than USDC's 6 decimals"):
        usdc_units("0.0000001")
    with pytest.raises(ValueError, match="finer than USDC's 6 decimals"):
        usdc_units("1.23456789")


def test_a_negative_amount_is_refused():
    with pytest.raises(ValueError, match="negative"):
        usdc_units("-1")


def test_nonsense_is_refused_as_an_amount():
    with pytest.raises(ValueError, match="not an amount"):
        usdc_units("about ten dollars")


# --- the decision commitment ----------------------------------------------

def test_the_same_record_hashes_the_same_however_the_dict_was_built():
    """The chain stores this hash. If key order moved it, a record would stop
    matching its own commitment for a reason that is not tampering."""
    a = {"billed": 1.0, "metered": 0.98, "par": 0.95, "rule": "over-par-reroute"}
    b = {"rule": "over-par-reroute", "par": 0.95, "metered": 0.98, "billed": 1.0}
    assert decision_hash(a) == decision_hash(b)


def test_changing_any_field_changes_the_hash():
    base = {"billed": 1.0, "metered": 0.98, "par": 0.95, "rule": "pay"}
    assert decision_hash(base) != decision_hash({**base, "par": 0.96})
    assert decision_hash(base) != decision_hash({**base, "rule": "hold"})
    assert decision_hash(base) != decision_hash({**base, "extra": 1})


def test_a_decision_hash_is_never_zero():
    """PolicyWallet rejects bytes32(0), so an encoding that could produce it
    would turn a valid decision into an unpayable one."""
    assert decision_hash({}) != b"\x00" * 32
    assert len(decision_hash({"a": 1})) == 32


# --- categories ------------------------------------------------------------

def test_long_category_names_stay_distinct():
    """Padding would truncate at 31 bytes and silently merge two budgets."""
    a = "model inference for the research team, europe"
    b = "model inference for the research team, america"
    assert len(a) > 31 and len(b) > 31
    assert category_id(a) != category_id(b)
    assert len(category_id(a)) == 32


def test_a_category_id_is_stable():
    assert category_id("infra") == category_id("infra")
    assert category_id("infra") != category_id("Infra")


# --- configuration refusals -----------------------------------------------

def _client(**kw) -> PolicyClient:
    return PolicyClient(rpc_url="http://127.0.0.1:1", wallet_address=None, **kw)


def test_an_unconfigured_client_reports_itself_and_refuses_to_spend():
    c = _client(agent_signer=None, owner_signer=None)
    assert c.configured() is False
    assert c.can_escalate() is False
    with pytest.raises(RuntimeError, match="not configured"):
        c.spend("infra", "0x" + "11" * 20, 1, {"rule": "pay"})


def test_reads_are_none_rather_than_a_guess_when_there_is_no_chain():
    """A budget this client cannot see must not read as a budget of zero: zero is
    a real answer that would make every payment look over-budget."""
    c = _client(agent_signer=None, owner_signer=None)
    assert c.budget("infra") is None
    assert c.approval_nonce() is None
    assert c.paused() is None


class _Sig:
    """Minimal Signer stand-in: an address is all these refusals examine."""

    def __init__(self, address: str) -> None:
        self._a = address

    @property
    def address(self) -> str:
        return self._a

    def sign_typed_data(self, domain, types, message, primary_type):  # pragma: no cover
        raise AssertionError("must not be reached: the refusal comes first")

    def send_transaction(self, w3, tx):  # pragma: no cover
        raise AssertionError("must not be reached: the refusal comes first")


SAME = "0x" + "aa" * 20
OTHER = "0x" + "bb" * 20


def test_one_key_holding_both_roles_cannot_approve_its_own_payment():
    """The whole point of the threshold is that a second party signs. An operator
    that is also the owner has no threshold, and should say so rather than
    produce an approval that looks like oversight."""
    c = PolicyClient(
        rpc_url="http://127.0.0.1:1",
        wallet_address="0x" + "cc" * 20,
        agent_signer=_Sig(SAME),
        owner_signer=_Sig(SAME),
    )
    with pytest.raises(RuntimeError, match="same key"):
        c.spend_approved("infra", OTHER, 500, {"rule": "pay"}, deadline=1)


def test_with_no_owner_key_a_large_payment_goes_to_a_human():
    c = PolicyClient(
        rpc_url="http://127.0.0.1:1",
        wallet_address="0x" + "cc" * 20,
        agent_signer=_Sig(SAME),
        owner_signer=None,
    )
    assert c.configured() is True, "it still runs; it just cannot clear large payments"
    assert c.can_escalate() is False
    with pytest.raises(RuntimeError, match="must go to a human"):
        c.spend_approved("infra", OTHER, 500, {"rule": "pay"}, deadline=1)


def test_the_wallet_address_actually_arrives_from_the_environment(monkeypatch):
    """A settings field read through a getattr default swallows its own env var:
    the client reports unconfigured while the operator looks wired. conftest
    strips every ACR_* var, so set it and rebuild the settings."""
    from acr_core import reset_settings

    addr = "0x" + "11" * 20
    monkeypatch.setenv("ACR_POLICY_WALLET_ADDRESS", addr)
    reset_settings()
    try:
        c = PolicyClient(agent_signer=None, owner_signer=None)
        assert c.wallet_address == addr
    finally:
        reset_settings()
