"""The join: park, ask a person, release or record. No network, no chain.

The three collaborators are each proved on their own elsewhere -- the ladder in
test_worldauth, the poll table in test_worldflow, the contract in
test_floatgate_onchain -- so this file is about the join, which is where the
states that are nobody's component live: a valid human whose payment the vault
then refuses, two polls racing for one single-use proof, and a provider that is
merely unreachable being filed as a denial.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from acr_oracle_client.float_vault import SpendReq
from index_api.floatgate import CONSUMED, DENIED, EXPIRED, FAILED, OPEN, PUBLIC_FIELDS, HumanGate
from index_api.worldauth import Claims, Verdict
from index_api.worldflow import Polled, Started

ISS = "https://auth.world.org"
SUB = "subject-0001"
ORB = "https://world.org/oidc/acr/orb"
BINDING = None  # filled by the fixture from the enrolled pair


def _req(quote: int = 18_540_000) -> SpendReq:
    return SpendReq(
        agent_id=b"scout".ljust(32, b"\x00"),
        seller="0x" + "11" * 20,
        index=b"ACR-GPU".ljust(32, b"\x00"),
        units=6000,
        quote_total=quote,
        print_id=1,
        nonce=b"\x01" * 32,
    )


@dataclass
class StubFlow:
    answers: list = field(default_factory=list)
    started: list = field(default_factory=list)

    def start(self, acr):
        self.started.append(tuple(acr))
        return Started(
            device_code="DEVICE-CODE-SECRET",
            user_code="WDJB-MJHT",
            verification_uri="https://world.org/device",
            verification_uri_complete="https://world.org/device?user_code=WDJB-MJHT",
            expires_in=600,
            interval=5,
        )

    def poll_once(self, code):
        return self.answers.pop(0) if self.answers else Polled("pending", "authorization_pending")


@dataclass
class StubVault:
    status: str = "ok"
    binding: bytes = b""
    signed: list = field(default_factory=list)
    executed: list = field(default_factory=list)
    resolved: list = field(default_factory=list)
    execute_raises: Exception | None = None
    _next_id: int = 40

    def vault_status(self):
        return self.status

    def treasurer_binding(self):
        return self.binding

    def classify(self, req):
        return {
            "reason": "over per-request threshold",
            "code": 11,
            "fair_usdc": 18_000_000,
            "print_id": 1,
        }

    def req_hash(self, req):
        return b"\x33" * 32

    def open_checkpoint(self, *, agent_id, req_hash, ttl_s, kind):
        self._next_id += 1
        return {
            "id": self._next_id,
            "req_hash": req_hash,
            "expires_at": 1_800_000_300,
            "kind": kind,
            "tx": "0xopen",
        }

    def sign_approval(self, *, cp_id, req_hash, expires_at, signer=None):
        self.signed.append(cp_id)
        return 27, b"\x01" * 32, b"\x02" * 32

    def execute_approved(self, *, cp_id, req, v, r, s):
        if self.execute_raises is not None:
            raise self.execute_raises
        self.executed.append(cp_id)
        return {"tx": "0xpaid"}

    def resolve_checkpoint(self, *, cp_id, outcome, reason):
        self.resolved.append((cp_id, outcome, reason))
        return {"tx": "0xresolved", "outcome": outcome}


@dataclass
class StubValidator:
    accepted_acr: tuple = (ORB,)
    verdict: Verdict | None = None
    seen: list = field(default_factory=list)

    def check(self, token, *, opened_at, now=None):
        self.seen.append(token)
        if self.verdict is not None:
            return self.verdict
        return Verdict(
            True,
            "ok",
            Claims(
                iss=ISS,
                sub=SUB,
                aud=(ISS,),
                exp=1_800_000_900,
                acr=ORB,
                amr=("pop",),
                auth_time=opened_at + 10,
            ),
        )


@pytest.fixture
def gate(tmp_path):
    from eth_utils import to_bytes
    from index_api.worldauth import treasurer_binding

    flow, vault = StubFlow(), StubVault()
    vault.binding = to_bytes(hexstr=treasurer_binding(ISS, SUB))
    spend_v, policy_v = StubValidator(), StubValidator(accepted_acr=("orb-face",))
    g = HumanGate(
        flow=flow,
        vault=vault,
        validator_for=lambda kind: policy_v if kind == "policy" else spend_v,
        approver=object(),
        ttl_s=300,
        treasurer=(ISS, SUB),
        log_path=str(tmp_path / "cps.jsonl"),
    )
    return {
        "g": g,
        "flow": flow,
        "vault": vault,
        "spend": spend_v,
        "policy": policy_v,
        "log": Path(str(tmp_path / "cps.jsonl")),
    }


def _rows(gate) -> list[dict]:
    p = gate["log"]
    return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []


# --- secrets ----------------------------------------------------------------


def test_neither_the_device_code_nor_the_id_token_reaches_the_public_view(gate):
    view = gate["g"].open(_req())
    blob = json.dumps(view)
    assert "DEVICE-CODE-SECRET" not in blob
    #: And it is not merely absent from the dict -- it is not on the checkpoint
    #: at all, so no future serialisation can reach it either.
    cp = gate["g"]._cps[view["id"]]
    assert "DEVICE-CODE-SECRET" not in json.dumps(cp.__dict__, default=str)


def test_the_public_view_carries_only_the_permitted_fields(gate):
    view = gate["g"].open(_req())
    assert set(view) == set(PUBLIC_FIELDS)


def test_the_user_code_disappears_once_the_checkpoint_is_finished(gate):
    g, flow = gate["g"], gate["flow"]
    view = g.open(_req())
    assert view["user_code"] == "WDJB-MJHT"
    flow.answers = [Polled("stop", "device_code_expired")]
    after = g.poll_once(view["id"])
    #: A spent code on a dashboard invites somebody to try it.
    assert after["user_code"] == ""
    assert after["verify_uri"] == ""


def test_a_finished_checkpoint_forgets_its_device_code(gate):
    g, flow = gate["g"], gate["flow"]
    view = g.open(_req())
    assert view["id"] in g._codes
    flow.answers = [Polled("stop", "refused_or_assurance_unmet")]
    g.poll_once(view["id"])
    assert view["id"] not in g._codes


# --- preflight --------------------------------------------------------------


def test_the_gate_will_not_park_a_payment_the_vault_cannot_release(gate):
    gate["vault"].status = "the treasury is paused"
    with pytest.raises(RuntimeError, match="treasury is paused"):
        gate["g"].open(_req())


def test_the_gate_will_not_park_when_nobody_is_enrolled(gate):
    gate["g"].treasurer = None
    with pytest.raises(RuntimeError, match="no treasurer is enrolled"):
        gate["g"].open(_req())


def test_the_gate_will_not_park_when_the_vault_binds_to_somebody_else(gate):
    """A valid signature over the wrong binding approves for the wrong person."""
    gate["vault"].binding = b"\x99" * 32
    assert "not the enrolled treasurer" in gate["g"].preflight()
    with pytest.raises(RuntimeError, match="not the enrolled treasurer"):
        gate["g"].open(_req())


# --- the poll table, as the gate sees it ------------------------------------


def test_a_pending_poll_leaves_it_open(gate):
    g = gate["g"]
    view = g.open(_req())
    assert g.poll_once(view["id"])["status"] == OPEN
    assert g.waiting() == [view["id"]]


def test_a_slow_down_widens_the_interval_and_keeps_it_open(gate):
    g, flow = gate["g"], gate["flow"]
    view = g.open(_req())
    before = g._cps[view["id"]].interval
    flow.answers = [Polled("slow_down", "slow_down")]
    assert g.poll_once(view["id"])["status"] == OPEN
    assert g._cps[view["id"]].interval == before + 5


def test_a_refusal_is_recorded_on_chain_as_denied(gate):
    g, flow, vault = gate["g"], gate["flow"], gate["vault"]
    view = g.open(_req())
    flow.answers = [Polled("stop", "refused_or_assurance_unmet")]
    out = g.poll_once(view["id"])
    assert out["status"] == DENIED
    assert vault.resolved == [(view["id"], DENIED, out["reason"])]
    assert vault.executed == []


def test_a_denial_names_the_three_things_world_cannot_distinguish(gate):
    g, flow = gate["g"], gate["flow"]
    view = g.open(_req())
    flow.answers = [Polled("stop", "refused_or_assurance_unmet")]
    reason = g.poll_once(view["id"])["reason"]
    #: "the human denied it" would send an operator to debug the wrong thing
    #: when the truth might be "that account is not verified enough".
    assert "declined" in reason and "assurance" in reason and "enrolled treasurer" in reason


def test_an_expired_device_code_is_recorded_as_expired(gate):
    g, flow, vault = gate["g"], gate["flow"], gate["vault"]
    view = g.open(_req())
    flow.answers = [Polled("stop", "device_code_expired")]
    assert g.poll_once(view["id"])["status"] == EXPIRED
    assert vault.resolved[0][1] == EXPIRED


def test_an_unreachable_provider_is_a_failure_and_never_an_approval(gate):
    g, flow, vault = gate["g"], gate["flow"], gate["vault"]
    view = g.open(_req())
    flow.answers = [Polled("stop", "provider_unavailable")]
    out = g.poll_once(view["id"])
    assert out["status"] == FAILED
    assert vault.executed == [] and vault.signed == []
    assert vault.resolved[0][1] == FAILED


def test_a_rate_limit_is_a_failure_not_a_denial(gate):
    g, flow = gate["g"], gate["flow"]
    view = g.open(_req())
    flow.answers = [Polled("stop", "rate_limited", retry_after=60.0)]
    assert g.poll_once(view["id"])["status"] == FAILED


# --- validation gates the signature ----------------------------------------


def test_a_token_that_fails_validation_signs_nothing(gate):
    g, flow, vault = gate["g"], gate["flow"], gate["vault"]
    gate["spend"].verdict = Verdict(False, "auth_time_outside_window")
    view = g.open(_req())
    flow.answers = [Polled("token", "ok", id_token="stale.but.signed")]
    out = g.poll_once(view["id"])
    assert out["status"] == FAILED
    assert "auth_time_outside_window" in out["reason"]
    #: The approver key is never asked. Not "the transaction reverted" -- the
    #: signature does not exist.
    assert vault.signed == [] and vault.executed == []


def test_another_humans_valid_token_is_a_failed_verification_not_a_denial(gate):
    g, flow = gate["g"], gate["flow"]
    gate["spend"].verdict = Verdict(False, "not_the_enrolled_treasurer")
    view = g.open(_req())
    flow.answers = [Polled("token", "ok", id_token="valid.wrong.human")]
    #: Nobody refused anything; the proof simply was not the right person's.
    assert g.poll_once(view["id"])["status"] == FAILED


# --- the happy path, once ---------------------------------------------------


def test_a_valid_proof_signs_once_executes_once_and_records_the_identity(gate):
    g, flow, vault = gate["g"], gate["flow"], gate["vault"]
    view = g.open(_req())
    flow.answers = [Polled("token", "ok", id_token="good.id.token")]
    out = g.poll_once(view["id"])
    assert out["status"] == CONSUMED
    assert out["tx"] == "0xpaid"
    assert vault.signed == [view["id"]] and vault.executed == [view["id"]]
    #: executeApproved emits CheckpointResolved(CONSUMED) itself, so resolving
    #: again here would revert "checkpoint closed".
    assert vault.resolved == []
    assert g._cps[view["id"]].identity["sub"] == SUB


def test_polling_a_consumed_checkpoint_changes_nothing(gate):
    g, flow, vault = gate["g"], gate["flow"], gate["vault"]
    view = g.open(_req())
    flow.answers = [Polled("token", "ok", id_token="good.id.token")]
    g.poll_once(view["id"])
    flow.answers = [Polled("token", "ok", id_token="good.id.token")]
    again = g.poll_once(view["id"])
    assert again["status"] == CONSUMED
    assert vault.executed == [view["id"]]


def test_a_second_poll_cannot_execute_a_claimed_checkpoint(gate):
    """Two pollers, one single-use proof: exactly one execution."""
    g, flow, vault = gate["g"], gate["flow"], gate["vault"]
    view = g.open(_req())
    cp = g._cps[view["id"]]
    cp.status = "claimed"  # as if another tick is mid-execution
    flow.answers = [Polled("token", "ok", id_token="good.id.token")]
    assert g.poll_once(view["id"])["status"] == "claimed"
    assert vault.signed == [] and vault.executed == []


# --- the state that is nobody's component ----------------------------------


def test_a_valid_human_whose_payment_the_vault_refuses_is_recorded_as_failed(gate):
    """The human approved; the band moved. Both facts are true at once.

    `executeApproved` re-checks the band, the cap and the print on the way
    through and reverts if any of them moved, rolling the whole transaction
    back -- so the checkpoint is still open on chain. But the proof is spent and
    a device code is redeemable once, so there is nothing to retry with.
    """
    g, flow, vault = gate["g"], gate["flow"], gate["vault"]
    vault.execute_raises = Exception("execution reverted: quote exceeds ACR fair band")
    view = g.open(_req())
    flow.answers = [Polled("token", "ok", id_token="good.id.token")]
    out = g.poll_once(view["id"])
    assert out["status"] == FAILED
    assert "approved, then the vault refused it" in out["reason"]
    assert "quote exceeds ACR fair band" in out["reason"]
    #: The revert reason, not a stack trace, and the refusal is on chain.
    assert "Traceback" not in out["reason"]
    assert vault.resolved[0][1] == FAILED


def test_a_chain_that_will_not_record_the_refusal_says_so(gate):
    g, flow, vault = gate["g"], gate["flow"], gate["vault"]
    view = g.open(_req())

    def boom(**kw):
        raise Exception("execution reverted: not executor")

    vault.resolve_checkpoint = boom
    flow.answers = [Polled("stop", "device_code_expired")]
    out = g.poll_once(view["id"])
    #: Reporting a clean refusal we failed to record would be a lie about
    #: where the evidence is.
    assert "not recorded on chain" in out["reason"]


def test_our_patience_is_host_time_and_runs_out(gate):
    g, vault = gate["g"], gate["vault"]
    view = g.open(_req())
    #: Host time bounds OUR polling, never the vault's TTL -- the chain owns
    #: that, and a local anvil has been measured 3,815 seconds off this clock.
    g._cps[view["id"]].opened_at -= 1000
    out = g.poll_once(view["id"])
    assert out["status"] == EXPIRED
    assert vault.resolved[0][1] == EXPIRED


# --- the ledger -------------------------------------------------------------


def test_every_outcome_reaches_the_ledger_including_the_refusals(gate):
    g, flow = gate["g"], gate["flow"]
    a = g.open(_req())
    flow.answers = [Polled("stop", "refused_or_assurance_unmet")]
    g.poll_once(a["id"])
    b = g.open(_req(quote=19_000_000))
    flow.answers = [Polled("token", "ok", id_token="good.id.token")]
    g.poll_once(b["id"])

    events = [r["event"] for r in _rows(gate)]
    assert events == ["opened", DENIED, "opened", CONSUMED]
    #: And the ledger must not carry what the view would not.
    assert "DEVICE-CODE-SECRET" not in gate["log"].read_text()
    assert "good.id.token" not in gate["log"].read_text()


def test_a_ledger_it_cannot_write_does_not_take_the_gate_down(gate):
    g = gate["g"]
    g.log_path = "/proc/nowhere/cps.jsonl"
    view = g.open(_req())
    assert view["status"] == OPEN


# --- kinds ------------------------------------------------------------------


def test_a_policy_checkpoint_asks_for_its_own_assurance_classes(gate):
    g, flow = gate["g"], gate["flow"]
    g.open(_req(), kind="policy")
    #: Changing the rules must not be clearable by whatever cleared the last
    #: payment, so the two kinds carry different accepted classes.
    assert flow.started[-1] == ("orb-face",)


def test_an_unknown_kind_is_refused(gate):
    with pytest.raises(ValueError, match="'spend' or 'policy'"):
        gate["g"].open(_req(), kind="transfer")


def test_an_unknown_checkpoint_is_a_key_error_not_a_silent_none(gate):
    with pytest.raises(KeyError):
        gate["g"].public(999)
    with pytest.raises(KeyError):
        gate["g"].poll_once(999)
