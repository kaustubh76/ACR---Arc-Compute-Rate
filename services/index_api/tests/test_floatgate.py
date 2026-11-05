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
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from acr_oracle_client.float_vault import SpendReq
from index_api.floatgate import (
    CONSUMED,
    DENIED,
    EXPIRED,
    FAILED,
    OPEN,
    PUBLIC_FIELDS,
    HumanGate,
    build_gate,
    deployed_vault,
    float_once,
    gate_enabled,
)
from index_api.worldauth import Claims, Verdict
from index_api.worldflow import Polled, Started

ISS = "https://auth.world.org"
SUB = "subject-0001"
ORB = "https://world.org/oidc/acr/orb"
ORB_FACE = "https://world.org/oidc/acr/orb-face"
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

    def supported_acr(self):
        return (ORB, ORB_FACE)


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
    spend_v, policy_v = StubValidator(), StubValidator(accepted_acr=(ORB_FACE,))
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
    assert flow.started[-1] == (ORB_FACE,)


def test_an_unknown_kind_is_refused(gate):
    with pytest.raises(ValueError, match="'spend' or 'policy'"):
        gate["g"].open(_req(), kind="transfer")


def test_an_unknown_checkpoint_is_a_key_error_not_a_silent_none(gate):
    with pytest.raises(KeyError):
        gate["g"].public(999)
    with pytest.raises(KeyError):
        gate["g"].poll_once(999)


# --- poll pacing ------------------------------------------------------------


def test_the_first_poll_is_due_immediately(gate):
    view = gate["g"].open(_req())
    assert gate["g"].due() == [view["id"]]


def test_a_polled_checkpoint_waits_out_its_own_interval(gate):
    g = gate["g"]
    view = g.open(_req())
    g.poll_once(view["id"])
    #: The provider sets the interval; polling on the worker's cadence instead
    #: would earn exactly the rate limit that `slow_down` exists to avoid.
    assert g.due() == []
    assert g.due(now=time.time() + g._cps[view["id"]].interval + 1) == [view["id"]]


def test_a_slow_down_pushes_the_next_poll_further_out(gate):
    g, flow = gate["g"], gate["flow"]
    view = g.open(_req())
    flow.answers = [Polled("slow_down", "slow_down")]
    g.poll_once(view["id"])
    widened = g._cps[view["id"]].interval
    at = time.time() + widened - 1
    assert g.due(now=at) == []
    assert g.due(now=time.time() + widened + 1) == [view["id"]]


def test_the_poll_is_stamped_even_when_the_provider_throws(gate):
    """A poll that raises must still wait out its interval rather than spin."""
    g = gate["g"]
    view = g.open(_req())

    def boom(code):
        raise RuntimeError("connection reset")

    gate["flow"].poll_once = boom
    with pytest.raises(RuntimeError):
        g.poll_once(view["id"])
    assert g._cps[view["id"]].last_poll_at > 0
    assert g.due() == []


def test_due_drains_oldest_first(gate):
    g = gate["g"]
    a = g.open(_req(quote=18_000_001))
    b = g.open(_req(quote=18_000_002))
    assert g.due() == [a["id"], b["id"]]


def test_a_finished_checkpoint_is_never_due(gate):
    g, flow = gate["g"], gate["flow"]
    view = g.open(_req())
    flow.answers = [Polled("stop", "device_code_expired")]
    g.poll_once(view["id"])
    assert g.due(now=time.time() + 10_000) == []


# --- the assurance cross-check ---------------------------------------------


def test_an_unadvertised_assurance_class_is_refused_before_anything_is_parked(gate):
    """An essential claim the issuer cannot meet is refused as `access_denied`.

    Which is also what a human declining looks like, so the only place this can
    be told apart is here, against discovery.
    """
    g = gate["g"]
    gate["flow"].supported_acr = lambda: ("https://world.org/oidc/acr/orb-face",)
    assert g.unadvertised_assurance() == {ORB}
    assert "does not advertise" in g.preflight()
    with pytest.raises(RuntimeError, match="does not advertise"):
        g.open(_req())


def test_unreadable_discovery_is_not_treated_as_a_misconfiguration(gate):
    def boom():
        raise RuntimeError("dns")

    gate["flow"].supported_acr = boom
    #: An unreachable provider is a different problem, and the poll table
    #: already refuses to call it an approval.
    assert gate["g"].unadvertised_assurance() == set()
    assert gate["g"].preflight() == "ok"


# --- the factory ------------------------------------------------------------


def test_the_gate_stands_down_when_it_is_not_switched_on(monkeypatch):
    monkeypatch.delenv("ACR_FLOAT_GATE", raising=False)
    assert gate_enabled() is False
    g, why = build_gate()
    assert g is None
    assert "not switched on" in why


def test_the_gate_names_every_setting_it_is_missing(monkeypatch):
    from acr_core import reset_settings

    monkeypatch.setenv("ACR_FLOAT_GATE", "1")
    reset_settings()
    try:
        g, why = build_gate()
        assert g is None
        assert why.startswith("not configured:")
        for name in ("ACR_WORLD_OIDC_ISSUER", "ACR_FLOAT_APPROVER_PRIVATE_KEY"):
            assert name in why
    finally:
        monkeypatch.undo()
        reset_settings()


def test_the_vault_address_comes_from_the_deployment_record(tmp_path):
    """Matched on the record's own chainId, not on a file name we agreed."""
    (tmp_path / "anvil.json").write_text(
        json.dumps({"net": "anvil", "chainId": 31337, "vault": "0x" + "11" * 20})
    )
    (tmp_path / "arc-testnet.json").write_text(
        json.dumps({"net": "whatever-they-call-it", "chainId": 5042002, "vault": "0x" + "22" * 20})
    )
    assert deployed_vault(31337, root=tmp_path) == "0x" + "11" * 20
    assert deployed_vault(5042002, root=tmp_path) == "0x" + "22" * 20
    assert deployed_vault(999, root=tmp_path) == ""


def test_a_deployment_record_that_will_not_parse_is_skipped_not_fatal(tmp_path):
    (tmp_path / "broken.json").write_text("{not json")
    (tmp_path / "good.json").write_text(json.dumps({"chainId": 31337, "vault": "0x" + "33" * 20}))
    assert deployed_vault(31337, root=tmp_path) == "0x" + "33" * 20


def test_a_missing_deployments_folder_is_not_fatal(tmp_path):
    assert deployed_vault(31337, root=tmp_path / "nope") == ""


# --- the chore --------------------------------------------------------------


def test_the_chore_is_silent_when_the_gate_is_off(monkeypatch):
    monkeypatch.delenv("ACR_FLOAT_GATE", raising=False)
    assert float_once() is None


def test_the_chore_says_why_it_is_not_polling(monkeypatch):
    from index_api import floatgate

    monkeypatch.setenv("ACR_FLOAT_GATE", "1")
    floatgate.reset_gate()
    try:
        verdict = float_once()
        assert verdict is not None and verdict.startswith("not polling:")
    finally:
        monkeypatch.undo()
        floatgate.reset_gate()


def test_the_chore_reports_what_it_polled(gate, monkeypatch):
    from index_api import floatgate

    monkeypatch.setenv("ACR_FLOAT_GATE", "1")
    floatgate.set_gate(gate["g"])
    try:
        view = gate["g"].open(_req())
        gate["flow"].answers = [Polled("stop", "refused_or_assurance_unmet")]
        assert float_once() == f"polled {view['id']}:denied"
        #: Nothing due now, so the next look is quiet rather than a repeated
        #: verdict that would read as a second denial.
        assert float_once() is None
    finally:
        monkeypatch.undo()
        floatgate.reset_gate()


def test_one_bad_checkpoint_does_not_cost_the_chore_its_pass(gate, monkeypatch):
    from index_api import floatgate

    monkeypatch.setenv("ACR_FLOAT_GATE", "1")
    floatgate.set_gate(gate["g"])
    try:
        a = gate["g"].open(_req(quote=18_000_001))
        b = gate["g"].open(_req(quote=18_000_002))
        calls = {"n": 0}
        real = gate["g"].poll_once

        def flaky(cp_id):
            calls["n"] += 1
            if cp_id == a["id"]:
                raise RuntimeError("one bad apple")
            return real(cp_id)

        gate["g"].poll_once = flaky
        verdict = float_once()
        assert f"{a['id']}:unpolled" in verdict
        assert f"{b['id']}:open" in verdict
        assert calls["n"] == 2
    finally:
        monkeypatch.undo()
        floatgate.reset_gate()


def test_gate_status_carries_the_reason_and_then_ok(gate):
    from index_api import floatgate

    floatgate.reset_gate()
    assert floatgate.gate_status() == "not built yet"
    floatgate.set_gate(gate["g"])
    assert floatgate.gate_status() == "ok"
    floatgate.set_gate(None)
    assert floatgate.gate_status() == "set to none by hand"
    floatgate.reset_gate()


# --- units and clocks -------------------------------------------------------


def test_the_public_view_speaks_usdc_and_not_units(gate):
    """A field named `_usdc` carries decimal USDC, as it does everywhere here.

    The first draft served `quote_total` straight through, so a quote of 18.54
    USDC serialised as 18540000 and any card rendering it was out by a million.
    The internal fields are named `_units` now, which is what the chain speaks.
    """
    view = gate["g"].open(_req(quote=18_540_000))
    assert view["quote_usdc"] == 18.54
    assert view["fair_usdc"] == 18.0
    cp = gate["g"]._cps[view["id"]]
    assert cp.quote_units == 18_540_000


def test_the_countdown_is_a_duration_not_a_difference_between_clocks(gate):
    """`expires_at` is chain time; a browser must never subtract its own.

    The two epochs have been measured 3,815 s apart on a local anvil, so the
    difference is meaningless. A DURATION is the same length in both clocks,
    which is why the view serves one.
    """
    view = gate["g"].open(_req())
    assert view["expires_in_s"] == gate["g"].ttl_s
    cp = gate["g"]._cps[view["id"]]
    cp.opened_at -= 60
    assert cp.public()["expires_in_s"] == gate["g"].ttl_s - 60
    #: And it floors at zero rather than going negative.
    cp.opened_at -= 10_000
    assert cp.public()["expires_in_s"] == 0


def test_the_countdown_does_not_move_when_only_the_chain_clock_would(gate):
    view = gate["g"].open(_req())
    cp = gate["g"]._cps[view["id"]]
    before = cp.public()["expires_in_s"]
    #: A chain timestamp an hour away changes what the vault compares against,
    #: and must not change what the human is told to count down from.
    cp.expires_at_chain += 3_600
    assert cp.public()["expires_in_s"] == before
