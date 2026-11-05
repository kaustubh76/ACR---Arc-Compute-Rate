"""One guest budget per unique human. No network, no chain.

The happy path is one test. The other twenty are the ones that matter, because
the product's whole sentence is "one per unique human" and the interesting part
is what stops the second one.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import pytest
from index_api.floatguest import (
    REASONS,
    SELFIE_SCHEMA_ID,
    GuestError,
    GuestGate,
    GuestLedger,
    PendingJoins,
    guest_agent_id,
    verify_uniqueness_proof,
)

NULL_A = "0x" + "aa" * 32
NULL_B = "0x" + "bb" * 32
AGENT = "0x" + "11" * 20
RP = "rp_test"


@dataclass
class StubVault:
    ready: str = "ok"
    exists: bool = False
    guest: bool = True
    cap: int = 2_000_000
    free: int = 100_000_000
    free_raises: bool = False
    chain_raises: bool = False
    register_raises: Exception | None = None
    registered: list = field(default_factory=list)

    def guest_preflight(self):
        return self.ready

    def agent_of(self, agent_id):
        if self.chain_raises:
            raise RuntimeError("rpc throttled")
        return {
            "exists": self.exists,
            "guest": self.guest,
            "daily_cap_units": self.cap,
            "spent_units": 0,
            "per_request_units": self.cap,
            "period_start": 0,
            "frozen": False,
        }

    def guest_daily_cap(self):
        return self.cap

    def total_value_usdc(self):
        if self.free_raises:
            raise RuntimeError("rpc throttled")
        return self.free

    def register_guest(self, agent_id):
        if self.register_raises is not None:
            raise self.register_raises
        self.registered.append(agent_id)
        return {"tx": "0xissued"}


def _established(**over) -> dict:
    base = {
        "nullifier": NULL_A,
        "sandbox_observed": False,
        "issuer_schema_id": SELFIE_SCHEMA_ID,
        "sybil_score": 10,
    }
    base.update(over)
    return base


@pytest.fixture
def gate(tmp_path):
    vault = StubVault()
    seen: list = []

    def stub_verify(payload, *, rp_id, environment, **kw):
        seen.append((payload, rp_id, environment))
        return _established(**(payload.get("_establishes") or {}))

    g = GuestGate(
        vault=vault,
        rp_id=RP,
        environment="production",
        min_sybil=5,
        ledger=GuestLedger(log_path=str(tmp_path / "guests.jsonl")),
        verify=stub_verify,
    )
    return {"g": g, "vault": vault, "seen": seen, "log": Path(str(tmp_path / "guests.jsonl"))}


def _join(gate, nonce="n1", **establishes) -> dict:
    gate["g"].bind(nonce, AGENT)
    payload = {"nonce": nonce, "action": "acr-float-guest-budget-v1"}
    if establishes:
        payload["_establishes"] = establishes
    return payload


def _rows(gate) -> list[dict]:
    p = gate["log"]
    return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []


# --- the agent id -----------------------------------------------------------


def test_the_agent_id_is_a_pure_function_of_the_nullifier():
    """Which is what lets the chain answer "already issued" with no state."""
    assert guest_agent_id(NULL_A) == guest_agent_id(NULL_A)
    assert guest_agent_id(NULL_A) != guest_agent_id(NULL_B)
    assert len(guest_agent_id(NULL_A)) == 32


def test_an_agent_id_needs_a_nullifier():
    with pytest.raises(ValueError, match="needs a nullifier"):
        guest_agent_id("")


# --- the join binding -------------------------------------------------------


def test_a_nonce_binds_one_wallet_and_spends_once():
    j = PendingJoins()
    j.bind("n", AGENT)
    assert j.spend("n") == AGENT
    #: Single use. A nonce that can be retried is not single use.
    assert j.spend("n") is None


def test_an_expired_nonce_is_refused_and_still_spent():
    j = PendingJoins(ttl_s=10)
    j.bind("n", AGENT, now=1_000)
    assert j.spend("n", now=1_050) is None
    #: Popped either way, so an expired nonce cannot be retried until it works.
    assert j.spend("n", now=1_000) is None


def test_an_unknown_nonce_is_refused(gate):
    with pytest.raises(GuestError) as exc:
        gate["g"].claim({"nonce": "never-issued"})
    assert exc.value.reason == "unknown_or_expired_request"
    assert exc.value.status == 400


def test_a_join_needs_both_halves(gate):
    for nonce, addr in (("", AGENT), ("n", "")):
        with pytest.raises(GuestError, match="nonce and an agent"):
            gate["g"].bind(nonce, addr)


# --- the proof --------------------------------------------------------------


def _verify_with(handler, **kw):
    return verify_uniqueness_proof(
        kw.pop(
            "payload", {"nonce": "n", "responses": [{"issuer_schema_id": 11, "sybil_score": 9}]}
        ),
        rp_id=RP,
        environment=kw.pop("environment", "production"),
        transport=httpx.MockTransport(handler),
        **kw,
    )


def test_a_proof_for_another_environment_never_reaches_the_network():
    """A staging proof verifies against a simulator, not a person."""
    called: list = []

    def handler(request):
        called.append(request)
        return httpx.Response(200, json={"success": True, "nullifier": NULL_A})

    with pytest.raises(GuestError) as exc:
        _verify_with(handler, payload={"nonce": "n", "environment": "staging"})
    assert exc.value.reason == "wrong_environment"
    assert called == []


def test_a_refused_proof_carries_the_providers_own_detail():
    def handler(request):
        return httpx.Response(400, json={"code": "invalid_proof", "detail": "proof did not verify"})

    with pytest.raises(GuestError) as exc:
        _verify_with(handler)
    assert exc.value.reason == "verify_failed"
    assert "proof did not verify" in exc.value.detail


def test_a_success_with_no_nullifier_is_refused():
    def handler(request):
        return httpx.Response(200, json={"success": True})

    with pytest.raises(GuestError) as exc:
        _verify_with(handler)
    assert exc.value.reason == "no_nullifier"


def test_the_v2_fallback_reads_the_other_field_name():
    """v4 says `nullifier`, v2 says `nullifier_hash`. One value, two names."""
    seen: list[str] = []

    def handler(request):
        seen.append(request.url.path)
        if "/v4/" in request.url.path:
            return httpx.Response(400, json={"code": "app_not_migrated"})
        return httpx.Response(200, json={"success": True, "nullifier_hash": "255"})

    out = _verify_with(handler)
    assert any("/v4/" in p for p in seen) and any("/v2/" in p for p in seen)
    #: And normalised to a 32-byte word, so a decimal and a hex of the same
    #: human cannot look like two people.
    assert out["nullifier"].endswith("ff")
    assert len(out["nullifier"]) == 66


def test_the_environment_is_observed_rather_than_asserted():
    def handler(request):
        return httpx.Response(
            200, json={"success": True, "nullifier": NULL_A, "environment": "staging"}
        )

    assert _verify_with(handler)["sandbox_observed"] is True


def test_an_unobservable_environment_is_none_and_not_production():
    def handler(request):
        return httpx.Response(200, json={"success": True, "nullifier": NULL_A})

    #: `None` says we could not see it, which is not the same as "production".
    assert _verify_with(handler)["sandbox_observed"] is None


def test_the_payload_is_forwarded_as_is_with_only_the_environment_overridden():
    bodies: list = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"success": True, "nullifier": NULL_A})

    _verify_with(
        handler, payload={"nonce": "n", "action": "a", "responses": [], "protocol_version": "4.0"}
    )
    sent = bodies[0]
    assert sent["protocol_version"] == "4.0" and sent["action"] == "a"
    assert sent["environment"] == "production"


# --- the sybil floor --------------------------------------------------------


def test_a_score_below_the_floor_is_refused(gate):
    with pytest.raises(GuestError) as exc:
        gate["g"].claim(_join(gate, sybil_score=1))
    assert exc.value.reason == "below_sybil_floor"
    assert gate["vault"].registered == []


def test_a_missing_score_on_a_selfie_check_is_below_the_floor(gate):
    with pytest.raises(GuestError, match="below the floor"):
        gate["g"].claim(_join(gate, sybil_score=None))


def test_the_floor_applies_only_to_the_credential_that_carries_one(gate):
    """Proof of Human has no sybil score, so a floor cannot be read from it."""
    out = gate["g"].claim(_join(gate, issuer_schema_id=1, sybil_score=None))
    assert out["ok"] is True


# --- one per human ----------------------------------------------------------


def test_the_happy_path_issues_one_budget(gate):
    out = gate["g"].claim(_join(gate))
    assert out["ok"] is True
    assert out["agent"] == AGENT
    assert out["daily_cap_usdc"] == 2.0
    assert out["tx"] == "0xissued"
    assert gate["vault"].registered == [guest_agent_id(NULL_A)]


def test_the_chain_says_this_human_already_has_one(gate):
    gate["vault"].exists = True
    with pytest.raises(GuestError) as exc:
        gate["g"].claim(_join(gate))
    assert exc.value.reason == "one_guest_budget_per_human"
    assert exc.value.status == 409
    assert gate["vault"].registered == []


def test_the_local_ledger_also_says_so(gate):
    gate["g"].claim(_join(gate, nonce="n1"))
    #: The chain stub still says no, so this is the ledger's own refusal --
    #: the layer that holds a slot while a write is in flight, which the chain
    #: cannot do because a pending registerGuest reads exists == false.
    with pytest.raises(GuestError) as exc:
        gate["g"].claim(_join(gate, nonce="n2"))
    assert exc.value.reason == "one_guest_budget_per_human"


def test_an_id_already_held_by_a_non_guest_is_not_a_409(gate):
    gate["vault"].exists, gate["vault"].guest = True, False
    with pytest.raises(GuestError) as exc:
        gate["g"].claim(_join(gate))
    #: A collision with an operator-registered agent is not "you already have
    #: one" and must not be papered over as if it were.
    assert exc.value.reason == "not_a_guest_agent"
    assert exc.value.status == 500


def test_the_agent_exists_revert_is_success_rather_than_an_error(gate):
    """The budget exists for this human, which is what the caller wanted.

    This is also what makes a crash between the claim and the receipt safe: on
    restart the disk is empty and the chain read is the only backstop, so a
    retry lands here rather than on a 500 for a budget that actually worked.
    """
    gate["vault"].register_raises = Exception("execution reverted: agent exists")
    with pytest.raises(GuestError) as exc:
        gate["g"].claim(_join(gate))
    assert exc.value.reason == "one_guest_budget_per_human"
    assert exc.value.status == 409
    #: And the slot is KEPT, not released: the human does have a budget.
    assert gate["g"].ledger.held(NULL_A)
    assert [r["event"] for r in _rows(gate)] == ["claimed", "issued"]


# --- failing closed ---------------------------------------------------------


def test_an_unreadable_chain_blocks_rather_than_issues(gate):
    """The one case where issuing anyway hands out a second budget."""
    gate["vault"].chain_raises = True
    with pytest.raises(GuestError) as exc:
        gate["g"].claim(_join(gate))
    assert exc.value.status == 503
    assert "nothing was issued" in exc.value.detail
    assert gate["vault"].registered == []


def test_a_vault_that_is_not_ours_is_refused_before_anything_is_claimed(gate):
    gate["vault"].ready = "our signer is not the vault's guest registrar"
    with pytest.raises(GuestError) as exc:
        gate["g"].claim(_join(gate))
    assert exc.value.status == 503
    assert _rows(gate) == []


def test_a_failed_write_frees_the_slot_but_keeps_the_line(gate):
    gate["vault"].register_raises = Exception("execution reverted: not registrar")
    with pytest.raises(GuestError) as exc:
        gate["g"].claim(_join(gate))
    assert exc.value.status == 502
    #: Freed in memory, so a retry can work.
    assert not gate["g"].ledger.held(NULL_A)
    #: The claim line stays: a restart replays it and re-consumes the slot.
    #: Forgiving a failed write is fine; forgetting a successful one is not.
    assert [r["event"] for r in _rows(gate)] == ["claimed"]


# --- the floor, not a cap ---------------------------------------------------


def test_an_empty_till_refuses_before_the_write(gate):
    gate["vault"].free = 1_000_000  # less than one guest budget
    with pytest.raises(GuestError) as exc:
        gate["g"].claim(_join(gate))
    assert exc.value.reason == "the_till_is_empty"
    assert gate["vault"].registered == []


def test_an_unreadable_balance_does_not_block(gate):
    """Inverted from the chain read, deliberately.

    A throttled balance call must not become a guest outage; an unreadable
    `agent_of` must, because that one is the uniqueness check.
    """
    gate["vault"].free_raises = True
    assert gate["g"].claim(_join(gate))["ok"] is True


# --- the nullifier stays off every surface ---------------------------------


def test_the_nullifier_reaches_neither_the_response_nor_the_ledger(gate):
    out = gate["g"].claim(_join(gate))
    assert NULL_A not in json.dumps(out)
    assert NULL_A[2:] not in json.dumps(out)
    assert out["human"].startswith("••••")
    text = gate["log"].read_text()
    assert NULL_A not in text and NULL_A[2:] not in text
    assert "••••" in text


def test_every_named_reason_is_spelled_the_same_everywhere():
    #: A reason a page branches on and a reason the server raises have to be
    #: the same string, so the set is declared once.
    assert len(set(REASONS)) == len(REASONS)
    assert "one_guest_budget_per_human" in REASONS
