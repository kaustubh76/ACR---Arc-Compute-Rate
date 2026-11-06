"""Parking a payment, and reading the queue. No chain, no network.

The action is deliberately NOT a route of its own: it lives in
`ops_actions.ACTIONS` and is reached through `/ops/actions`, which is the house
answer for anything that spends money — it inherits the token gate, the
dry-by-default body, a per-action cap and an audit of every outcome including
the refusals. Only the two READS are routes, because a public view of what is
parked carries no secret.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient
from index_api import floatgate, ops_actions

AGENT = "scout"
SELLER = "0x" + "11" * 20
INDEX = "ACR-GPU"
#: What the vault's own ladder calls an escalation: over the agent's
#: per-request threshold, and the one code it leaves re-executable.
D_PER_REQUEST = 11
D_BAND = 10


@dataclass
class StubVault:
    code: int = D_PER_REQUEST
    reason: str = "over per-request threshold"
    fair: int = 18_000_000
    print_id: int = 7
    seen: list = field(default_factory=list)

    def classify(self, req):
        self.seen.append(req)
        return {
            "reason": self.reason,
            "code": self.code,
            "fair_usdc": self.fair,
            "print_id": self.print_id,
        }


@dataclass
class StubGate:
    vault: StubVault = field(default_factory=StubVault)
    ttl_s: int = 300
    ready: str = "ok"
    opened: list = field(default_factory=list)

    def preflight(self):
        return self.ready

    def open(self, req, *, kind="spend", reason=""):
        self.opened.append((req, kind, reason))
        return {
            "id": 41,
            "kind": kind,
            "status": "open",
            "reason": reason,
            "agent": AGENT,
            "seller": SELLER,
            "index": INDEX,
            "units": req.units,
            "quote_usdc": req.quote_total / 1e6,
            "fair_usdc": self.vault.fair / 1e6,
            "user_code": "WDJB-MJHT",
            "verify_uri": "https://world.org/device?user_code=WDJB-MJHT",
            "expires_at": 1_800_000_300,
            "expires_in_s": 287,
            "tx": None,
        }

    def public_all(self):
        return [self._view()]

    def _view(self):
        return {"id": 41, "status": "open", "user_code": "WDJB-MJHT"}

    def public(self, cp_id):
        if int(cp_id) != 41:
            raise KeyError(cp_id)
        return self._view()


def _params(**over) -> dict:
    base = {
        "agent": AGENT,
        "seller": SELLER,
        "index": INDEX,
        "units": 6000,
        "quote_usdc": "18.54",
        "print_id": 7,
    }
    base.update(over)
    return base


@pytest.fixture
def gate(monkeypatch, tmp_path):
    monkeypatch.setenv("ACR_OPS_AUDIT_PATH", str(tmp_path / "ops.jsonl"))
    monkeypatch.setattr(ops_actions, "AUDIT_PATH", str(tmp_path / "ops.jsonl"))
    g = StubGate()
    floatgate.set_gate(g)
    try:
        yield g
    finally:
        floatgate.reset_gate()
        monkeypatch.undo()


def _audit(tmp_path) -> list[dict]:
    p = tmp_path / "ops.jsonl"
    return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []


# --- the action -------------------------------------------------------------


def test_the_action_is_in_the_registry_which_is_the_allowlist():
    assert "float/checkpoint" in ops_actions.ACTIONS
    fn, desc = ops_actions.ACTIONS["float/checkpoint"]
    assert "human" in desc


def test_parking_without_a_gate_says_why(monkeypatch):
    floatgate.reset_gate()
    monkeypatch.delenv("ACR_FLOAT_GATE", raising=False)
    with pytest.raises(ops_actions.ActionError) as exc:
        ops_actions.float_checkpoint(_params(), True)
    assert exc.value.status == 503
    assert "not available" in str(exc.value)


def test_the_agent_id_is_derived_the_way_the_vault_derives_it(gate):
    """`keccak256("scout")` — the deploy script's own convention.

    A different derivation would park against an agent the vault has never
    heard of, and the refusal would read "unknown agent" rather than "you
    typed the id differently".
    """
    from eth_utils import keccak

    ops_actions.float_checkpoint(_params(), True)
    assert gate.vault.seen[-1].agent_id == bytes(keccak(text="scout"))


def test_a_thirty_two_byte_word_is_taken_as_given(gate):
    word = "0x" + "ab" * 32
    ops_actions.float_checkpoint(_params(agent=word), True)
    assert gate.vault.seen[-1].agent_id == bytes.fromhex("ab" * 32)


def test_a_malformed_id_is_refused_rather_than_hashed(gate):
    for bad in ("0xdeadbeef", "0xnothex" + "0" * 57):
        with pytest.raises(ops_actions.ActionError, match="32-byte word|not hex"):
            ops_actions.float_checkpoint(_params(agent=bad), True)


def test_a_dry_run_prices_it_and_parks_nothing(gate):
    out = ops_actions.float_checkpoint(_params(), True)
    assert out["would"].startswith("park this payment")
    assert out["quote_usdc"] == 18.54
    assert out["fair_usdc"] == 18.0
    assert out["chain_says"] == "over per-request threshold"
    assert gate.opened == []


def test_a_live_run_parks_and_returns_the_public_view(gate):
    out = ops_actions.float_checkpoint(_params(), False)
    assert out["parked"]["id"] == 41
    assert out["parked"]["user_code"] == "WDJB-MJHT"
    assert len(gate.opened) == 1
    req, kind, _reason = gate.opened[0]
    assert kind == "spend"
    assert req.quote_total == 18_540_000


def test_the_chain_decides_what_may_be_parked_not_us(gate):
    """Only the escalation code is parkable, and the vault decides which."""
    gate.vault.code, gate.vault.reason = 0, ""
    with pytest.raises(ops_actions.ActionError, match="without a human"):
        ops_actions.float_checkpoint(_params(), True)

    gate.vault.code, gate.vault.reason = D_BAND, "quote exceeds ACR fair band"
    with pytest.raises(ops_actions.ActionError, match="refuses this outright") as exc:
        ops_actions.float_checkpoint(_params(), True)
    #: The chain's own sentence, not a paraphrase.
    assert "quote exceeds ACR fair band" in str(exc.value)


def test_a_quote_over_the_console_cap_is_refused(gate):
    with pytest.raises(ops_actions.ActionError, match="per-checkpoint cap"):
        ops_actions.float_checkpoint(_params(quote_usdc="10000"), True)


def test_an_amount_this_rail_cannot_express_is_refused_not_rounded(gate):
    #: usdc_units refuses rather than rounds: 0.0000001 is not 0 and not 1 unit.
    with pytest.raises(ops_actions.ActionError, match="quote_usdc"):
        ops_actions.float_checkpoint(_params(quote_usdc="0.0000001"), True)


def test_units_must_be_a_positive_whole_number(gate):
    for bad in (0, -5):
        with pytest.raises(ops_actions.ActionError, match="positive"):
            ops_actions.float_checkpoint(_params(units=bad), True)
    with pytest.raises(ops_actions.ActionError, match="whole number"):
        ops_actions.float_checkpoint(_params(units="six thousand"), True)


def test_the_print_id_comes_from_the_chain_when_it_is_not_given(gate):
    """`classify` returns the live print id even while refusing a stale one."""
    out = ops_actions.float_checkpoint(_params(print_id=None), True)
    assert out["print_id"] == 7
    #: Probed with zero first, then rebuilt against what the chain answered.
    assert gate.vault.seen[0].print_id == 0
    assert gate.vault.seen[-1].print_id == 7


def test_no_usable_print_is_a_conflict_not_a_park(gate):
    gate.vault.print_id = 0
    gate.vault.reason = "no print for index"
    with pytest.raises(ops_actions.ActionError, match="no usable print"):
        ops_actions.float_checkpoint(_params(print_id=None), True)


def test_a_gate_that_is_not_ready_refuses_before_parking(gate):
    gate.ready = "the treasurer binding is unset, so an approval would bind to nobody"
    with pytest.raises(ops_actions.ActionError, match="binding is unset"):
        ops_actions.float_checkpoint(_params(), False)
    assert gate.opened == []


def test_each_park_gets_a_fresh_nonce(gate):
    ops_actions.float_checkpoint(_params(), False)
    ops_actions.float_checkpoint(_params(), False)
    assert gate.opened[0][0].nonce != gate.opened[1][0].nonce


def test_every_outcome_is_audited_including_the_refusal(gate, tmp_path):
    ops_actions.run("float/checkpoint", _params(), True)
    with pytest.raises(ops_actions.ActionError):
        ops_actions.run("float/checkpoint", _params(quote_usdc="10000"), True)
    rows = _audit(tmp_path)
    assert [r["ok"] for r in rows] == [True, False]
    assert all(r["action"] == "float/checkpoint" for r in rows)
    assert "per-checkpoint cap" in rows[1]["error"]


# --- the two reads ----------------------------------------------------------


def _client() -> TestClient:
    from index_api.app import app

    return TestClient(app)


def test_the_queue_says_pending_rather_than_empty_when_no_gate_runs():
    floatgate.reset_gate()
    body = _client().get("/float/checkpoints").json()
    #: An empty list would read as "nothing is parked" when the truth is "this
    #: host does not run the gate".
    assert body["status"] == "pending"
    assert body["checkpoints"] == []
    assert body["reason"]


def test_the_queue_lists_what_is_parked(gate):
    body = _client().get("/float/checkpoints").json()
    assert body["status"] == "ok"
    assert body["checkpoints"][0]["id"] == 41


def test_one_checkpoint_reads_back(gate):
    body = _client().get("/float/checkpoint/41").json()
    assert body["status"] == "ok"
    assert body["checkpoint"]["id"] == 41


def test_the_envelope_status_and_the_checkpoint_status_stay_apart(gate):
    """One word, two meanings, and the reader must be able to tell which.

    The envelope says whether this HOST could answer; the checkpoint says what
    the human did. Flattening them let a parked payment report status "open"
    where a caller was reading for "ok".
    """
    body = _client().get("/float/checkpoint/41").json()
    assert body["status"] == "ok"
    assert body["checkpoint"]["status"] == "open"


def test_an_unknown_checkpoint_is_a_404(gate):
    r = _client().get("/float/checkpoint/999")
    assert r.status_code == 404
    assert "no such checkpoint" in r.json()["detail"]


def test_a_checkpoint_on_no_host_reads_pending_not_404():
    floatgate.reset_gate()
    r = _client().get("/float/checkpoint/41")
    assert r.status_code == 200
    assert r.json()["status"] == "pending"


def test_neither_read_can_leak_a_device_code(gate):
    c = _client()
    for path in ("/float/checkpoints", "/float/checkpoint/41"):
        text = c.get(path).text
        assert "device_code" not in text
        assert "id_token" not in text


def test_the_reads_are_absent_from_the_paid_set():
    """They are gated by a token, not by money, like /tca/human."""
    from index_api.app import GATED_ENDPOINTS

    assert not [p for p in GATED_ENDPOINTS if p.startswith("/float")]


# --- the guest join pair ----------------------------------------------------
#
# `floatguest.py` was complete and tested for a day before anything could
# reach it over HTTP: the module existed, `app.py` never imported it, and it
# defined no router. These cover the two routes that closed that gap, and the
# shape they must keep for a join page to be able to branch on a refusal.


@dataclass
class StubGuestGate:
    """Enough of `GuestGate` to exercise the routes, and nothing more."""

    bound: list = field(default_factory=list)
    claimed: list = field(default_factory=list)
    raise_on_bind: object = None
    raise_on_claim: object = None
    result: dict = field(
        default_factory=lambda: {
            "ok": True,
            "agent": "0x" + "ab" * 20,
            "agent_id": "0x" + "cd" * 32,
            "daily_cap_usdc": 2.0,
            "tx": "0x" + "ef" * 32,
            #: Masked at the source, never the nullifier.
            "human": "••••f3a",
            "sandbox_observed": False,
        }
    )

    def bind(self, nonce, agent):
        if self.raise_on_bind:
            raise self.raise_on_bind
        self.bound.append((nonce, agent))

    def claim(self, payload):
        if self.raise_on_claim:
            raise self.raise_on_claim
        self.claimed.append(payload)
        return self.result


@pytest.fixture
def guest():
    from index_api import floatguest

    g = StubGuestGate()
    floatguest.set_guest_gate(g)
    yield g
    floatguest.set_guest_gate(None)


def _client():
    from index_api.app import app

    return TestClient(app)


def test_a_join_binds_a_nonce_to_one_wallet(guest):
    r = _client().post(
        "/float/guest/bind", json={"nonce": "n-1", "agent": "0x" + "ab" * 20}
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "ok"}
    assert guest.bound == [("n-1", "0x" + "ab" * 20)]


def test_a_guest_budget_is_issued_and_the_result_is_nested(guest):
    r = _client().post("/float/guest/claim", json={"nonce": "n-1", "proof": {"x": 1}})
    assert r.status_code == 200, r.text
    body = r.json()
    #: The envelope's own word stays separate from the claim's, for the same
    #: reason the checkpoint read keeps them apart: one word, one meaning.
    assert body["status"] == "ok"
    assert body["claim"]["ok"] is True
    assert body["claim"]["daily_cap_usdc"] == 2.0


def test_the_proof_reaches_the_gate_untouched_with_the_nonce_added(guest):
    _client().post(
        "/float/guest/claim",
        json={"nonce": "n-9", "proof": {"responses": [{"issuer_schema_id": 11}], "keep": "me"}},
    )
    #: Forwarded whole. World's docs say the result needs no remapping, and a
    #: field renamed here would be a contract we do not own, re-derived.
    assert guest.claimed == [
        {"responses": [{"issuer_schema_id": 11}], "keep": "me", "nonce": "n-9"}
    ]


def test_a_named_refusal_survives_as_a_reason_a_page_can_branch_on(guest):
    from index_api.floatguest import GuestError

    guest.raise_on_claim = GuestError(409, "one_guest_budget_per_human", "one budget per human")
    r = _client().post("/float/guest/claim", json={"nonce": "n-1", "proof": {}})
    assert r.status_code == 409
    detail = r.json()["detail"]
    #: BOTH, deliberately: a page branches on `reason` and shows `detail`.
    assert detail["reason"] == "one_guest_budget_per_human"
    assert detail["detail"] == "one budget per human"


def test_every_named_guest_refusal_can_reach_the_route(guest):
    """The tuple is the contract a join page is written against."""
    from index_api.floatguest import REASONS, GuestError

    seen = set()
    for reason in REASONS:
        guest.raise_on_claim = GuestError(400, reason, f"detail for {reason}")
        r = _client().post("/float/guest/claim", json={"nonce": "n", "proof": {}})
        seen.add(r.json()["detail"]["reason"])
    assert seen == set(REASONS)


def test_a_host_with_no_guest_gate_says_pending_not_broken():
    from index_api import floatguest

    floatguest.set_guest_gate(None)
    for path, body in (
        ("/float/guest/bind", {"nonce": "n", "agent": "0x" + "ab" * 20}),
        ("/float/guest/claim", {"nonce": "n", "proof": {}}),
    ):
        r = _client().post(path, json=body)
        assert r.status_code == 200, r.text
        #: "pending", never a 500: this host simply does not run the join page.
        assert r.json()["status"] == "pending"
        assert r.json()["reason"]


def test_the_claim_response_carries_no_nullifier(guest):
    r = _client().post("/float/guest/claim", json={"nonce": "n-1", "proof": {}})
    blob = json.dumps(r.json())
    assert "nullifier" not in blob
    #: What a reader gets is the mask and the hash the chain stores.
    assert r.json()["claim"]["human"].startswith("•")


def test_the_guest_gate_stands_down_with_a_named_reason_when_unconfigured():
    from index_api import floatguest

    class Bare:
        float_vault_address = ""
        float_guest_registrar_private_key = ""
        float_guest_rp_id = ""
        arc_rpc_url = ""

    gate, why = floatguest.build_guest_gate(Bare())
    assert gate is None
    #: It names every missing key at once, so an operator fixes one .env rather
    #: than discovering the next absence on the next run.
    for key in (
        "ACR_FLOAT_VAULT_ADDRESS",
        "ACR_FLOAT_GUEST_REGISTRAR_PRIVATE_KEY",
        "ACR_FLOAT_GUEST_RP_ID",
    ):
        assert key in why


def test_the_join_pair_is_absent_from_the_paid_set():
    from index_api.app import GATED_ENDPOINTS

    assert "/float/guest/bind" not in GATED_ENDPOINTS
    assert "/float/guest/claim" not in GATED_ENDPOINTS
