"""Warns before the wallet: what reaches the chain, and what never does.

`docs/INTEGRATION-WARNS.md` fixes the shape: ACR hashes, Warns signs, the id is
inside the hash and the signature is not. These tests hold the operator to the
part that agreement cannot check by itself: that the hash Warns signed is the
hash the contract receives, that the logged row still reproduces it, and that
every answer other than an allow (a hold, a block, a timeout, a refused
signature) leaves the wallet untouched.
"""

from __future__ import annotations

import json

import httpx
import pytest
from acr_oracle_client.policy import decision_hash
from index_api.operator import ESCALATE, PAY, REFUSE, Obligation, hashable_record, run_obligation
from index_api.warns import (
    ARC_TESTNET,
    ARC_USDC,
    WarnsClient,
    WarnsUnavailable,
    WarnsVerdict,
    get_warns,
    idempotency_key,
    payee_of,
)

VENDOR = "0x" + "aa" * 20
OTHER = "0x" + "bb" * 20
THIRD = "0x" + "cc" * 20
WALLET = "0x" + "77" * 20
RES = "https://acr.example/compute/inference"
NOW = 1_790_000_000.0
TX = "0x" + "ab" * 32
DECISION = "4c2f8e0a-0000-4000-8000-000000000001"

CATALOG = {
    "items": [
        {"resource": RES, "accepts": [{"amount": "1000000", "payTo": VENDOR}]},
        {"resource": RES, "accepts": [{"amount": "1000000", "payTo": OTHER}]},
        {"resource": RES, "accepts": [{"amount": "1000000", "payTo": THIRD}]},
    ]
}
RECEIPTS = [
    {"seller": VENDOR, "resource": RES, "quantity": 1_000.0, "amount_usdc": 1.0,
     "settled_at": NOW - 100},
]


def _ob(**kw) -> Obligation:
    base = dict(
        obligation_id="ob-1",
        vendor=VENDOR,
        billed_usdc=1.0,
        category="infra",
        resource=RES,
        vendor_quantity=1_000.0,
        invoice_ref="INV-0042",
    )
    base.update(kw)
    return Obligation(**base)


class _FakePolicy:
    """PolicyClient's surface on the paying path, and the wallet Warns is asked about."""

    def __init__(self, fail: bool = False):
        self.wallet_address = WALLET
        self.fail = fail
        self.calls: list[tuple] = []

    def budget(self, category):
        return {"category": category, "cap_usdc": 1_000.0, "spent_usdc": 0.0,
                "remaining_usdc": 100.0, "per_tx_limit_usdc": 50.0,
                "period_start": 0, "period_length": 0}

    def spend(self, category, to, amount, record):
        self.calls.append((category, to, amount, record))
        if self.fail:
            raise RuntimeError(f"policy tx reverted ({TX})")
        return TX


class _FakeWarns:
    """Answers like Warns, and remembers what it was asked and what it signed."""

    def __init__(self, outcome="allow", enforcement="enforced", *, decide_fails=False,
                 commit_fails=False, code="NEW_DESTINATION"):
        self.outcome = outcome
        self.enforcement = enforcement
        self.decide_fails = decide_fails
        self.commit_fails = commit_fails
        self.code = code
        self.asked: list[dict] = []
        self.signed: list[bytes] = []
        self.reports: list[tuple] = []

    def decide(self, **kw):
        self.asked.append(kw)
        if self.decide_fails:
            raise WarnsUnavailable("/v1/decisions: ConnectTimeout")
        reasons = () if self.outcome == "allow" else (
            {"code": self.code, "message": "first payment to this address"},
        )
        return WarnsVerdict(
            decision_id=DECISION,
            outcome=self.outcome,
            enforcement=self.enforcement,
            reasons=reasons,
            review_id="rv-1" if self.outcome == "review" else "",
        )

    def commit(self, decision_id, h):
        if self.commit_fails:
            raise WarnsUnavailable("commitment: HTTP 409 DECISION_NOT_ALLOWED")
        self.signed.append(h)
        return "warns-commitment-sig"

    def report(self, decision_id, tx, success):
        self.reports.append((decision_id, tx, success))
        return True


def _run(tmp_path, warns, policy=None, **kw):
    return run_obligation(
        _ob(),
        receipts=RECEIPTS,
        catalog=CATALOG,
        policy=policy if policy is not None else _FakePolicy(),
        now=NOW,
        dry_run=kw.pop("dry_run", False),
        log_path=str(tmp_path / "d.jsonl"),
        warns=warns,
        **kw,
    )


# --- an allow: the id in the hash, the signature beside it ------------------


def test_an_allowed_payment_commits_to_the_hash_warns_signed(tmp_path):
    pol, w = _FakePolicy(), _FakeWarns()
    d = _run(tmp_path, w, pol)

    assert d.intent == PAY and d.tx == TX and d.paid_usdc == pytest.approx(1.0)
    (_, _, _, record), = pol.calls
    assert record["warns_decision_id"] == DECISION, "the chain must name Warns' decision"
    assert "warns_signature" not in record, "a signature cannot sit inside what it signs"
    assert w.signed == [decision_hash(record)], (
        "the hash the contract receives is not the one Warns signed"
    )
    assert d.warns_signature == "warns-commitment-sig"
    assert w.reports == [(DECISION, TX, True)]


def test_the_logged_row_still_reproduces_the_signed_hash(tmp_path):
    """A reviewer re-derives the hash from the log through `hashable_record`.
    The signature is on the row, and it must be stripped like `tx` is."""
    w = _FakeWarns()
    _run(tmp_path, w)
    row = json.loads((tmp_path / "d.jsonl").read_text().strip().splitlines()[-1])
    assert row["warns_signature"] == "warns-commitment-sig"
    assert decision_hash(hashable_record(row)) == w.signed[0]


def test_warns_is_asked_about_the_wallet_not_the_agent_key(tmp_path):
    w = _FakeWarns()
    _run(tmp_path, w)
    (asked,) = w.asked
    assert asked["payer"] == WALLET, "the tokens leave the PolicyWallet"
    assert asked["to"] == VENDOR
    assert asked["amount_atomic"] == 1_000_000
    assert asked["payee"] == "acr.example", "the service, so a swapped payTo stands out"
    assert asked["invoice_id"] == "INV-0042"


# --- everything else leaves the wallet alone -------------------------------


def test_a_hold_is_an_escalation_and_nothing_is_sent(tmp_path):
    pol, w = _FakePolicy(), _FakeWarns("review")
    d = _run(tmp_path, w, pol)
    assert pol.calls == []
    assert d.intent == ESCALATE and d.escalated is True
    assert d.recommended_intent == PAY, "the agent's own ladder said pay"
    assert d.rule.startswith("Warns held it for review: NEW_DESTINATION")
    assert any("rv-1" in n for n in d.notes)
    assert d.warns_decision_id == "", "a held decision authorised nothing"
    assert w.signed == [] and w.reports == []


def test_a_block_is_a_refusal(tmp_path):
    pol, w = _FakePolicy(), _FakeWarns("block", code="DESTINATION_CHANGED")
    d = _run(tmp_path, w, pol)
    assert pol.calls == []
    assert d.intent == REFUSE and d.escalated is False
    assert d.rule.startswith("Warns blocked it: DESTINATION_CHANGED")
    assert d.warns_decision_id == ""


def test_a_warns_that_cannot_answer_is_not_a_pass(tmp_path):
    pol = _FakePolicy()
    d = _run(tmp_path, _FakeWarns(decide_fails=True), pol)
    assert pol.calls == []
    assert d.intent == ESCALATE and "Warns could not be asked" in d.rule


def test_an_allow_warns_would_not_sign_is_not_paid(tmp_path):
    pol = _FakePolicy()
    d = _run(tmp_path, _FakeWarns(commit_fails=True), pol)
    assert pol.calls == []
    assert d.intent == ESCALATE and "did not sign the record" in d.rule


def test_a_failed_spend_is_reported_and_still_raises(tmp_path):
    w = _FakeWarns()
    with pytest.raises(RuntimeError, match="reverted"):
        _run(tmp_path, w, _FakePolicy(fail=True))
    assert w.reports == [(DECISION, None, False)], "the reservation must be released"


# --- monitor mode, dry runs, and off ----------------------------------------


def test_monitor_mode_pays_without_claiming_an_authorisation(tmp_path):
    pol, w = _FakePolicy(), _FakeWarns("review", enforcement="shadow")
    d = _run(tmp_path, w, pol)
    assert d.intent == PAY and len(pol.calls) == 1
    (_, _, _, record), = pol.calls
    assert record["warns_decision_id"] == ""
    assert any("monitor mode, would have held it" in n for n in record["notes"])
    assert w.reports == [(DECISION, TX, True)], "Warns still learns the payment happened"


def test_a_dry_run_never_asks_warns(tmp_path):
    w = _FakeWarns()
    d = _run(tmp_path, w, dry_run=True)
    assert d.intent == PAY and w.asked == []


def test_false_means_no_warns_and_the_payment_is_unchanged(tmp_path):
    pol = _FakePolicy()
    d = _run(tmp_path, False, pol)
    assert d.intent == PAY and len(pol.calls) == 1
    assert d.warns_decision_id == "" and d.warns_signature == ""


def test_warns_is_off_unless_a_key_is_set(monkeypatch):
    monkeypatch.delenv("ACR_WARNS_API_KEY", raising=False)
    assert get_warns("acme") is None
    monkeypatch.setenv("ACR_WARNS_API_KEY", "warns_test_x")
    monkeypatch.setenv("ACR_WARNS_AGENT_ID", "acr-{business}")
    client = get_warns("acme")
    assert client is not None and client.agent_id == "acr-acme"
    assert client.network == ARC_TESTNET and client.token == ARC_USDC


def test_warns_is_asked_about_the_chain_this_host_pays_on(monkeypatch):
    from acr_core import reset_settings

    monkeypatch.setenv("ACR_WARNS_API_KEY", "warns_test_x")
    monkeypatch.setenv("ACR_ARC_CHAIN_ID", "5042")
    reset_settings()
    try:
        assert get_warns("acr-mainnet").network == "eip155:5042"
    finally:
        monkeypatch.delenv("ACR_ARC_CHAIN_ID")
        reset_settings()


# --- the HTTP client ----------------------------------------------------------


def _client(handler) -> WarnsClient:
    return WarnsClient("warns_test_x", "acr-acme", api_url="https://warns.test",
                       transport=httpx.MockTransport(handler))


def test_the_client_sends_a_transfer_decision():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["authorization"]
        seen["idem"] = request.headers["idempotency-key"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"decisionId": DECISION, "outcome": "allow",
                                         "enforcement": "enforced", "reasons": []})

    v = _client(handler).decide(obligation_id="ob-1", payer=WALLET, to=VENDOR,
                                amount_atomic=4410, payee="acr.example", invoice_id="INV-1")
    assert v.outcome == "allow" and v.decision_id == DECISION and v.enforced
    assert seen["auth"] == "Bearer warns_test_x"
    assert seen["body"] == {
        "kind": "transfer", "agentId": "acr-acme", "payer": WALLET,
        "network": ARC_TESTNET, "token": ARC_USDC, "to": VENDOR, "amountAtomic": "4410",
        "intent": {"payee": "acr.example", "invoiceId": "INV-1"},
    }
    assert 8 <= len(seen["idem"]) <= 64


def test_every_attempt_takes_a_new_idempotency_key():
    """The retry of an approved review needs a new key, or Warns hands back the review."""
    a, b = idempotency_key("ob-1"), idempotency_key("ob-1")
    assert a != b and a.split("-")[1] == b.split("-")[1]


def test_an_error_names_its_code_and_never_its_body():
    def handler(request):
        return httpx.Response(401, json={"error": {"code": "UNAUTHENTICATED",
                                                   "message": "echo of a secret"}})

    with pytest.raises(WarnsUnavailable, match="HTTP 401 UNAUTHENTICATED") as exc:
        _client(handler).decide(obligation_id="ob-1", payer=WALLET, to=VENDOR, amount_atomic=1)
    assert "secret" not in str(exc.value)


def test_the_commitment_carries_the_32_bytes_as_hex():
    seen = {}

    def handler(request):
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"decisionId": DECISION, "commitment": "sig"})

    h = bytes(range(32))
    assert _client(handler).commit(DECISION, h) == "sig"
    assert seen["path"] == f"/v1/decisions/{DECISION}/commitment"
    assert seen["body"] == {"decisionHash": "0x" + h.hex()}


def test_a_report_never_raises():
    def handler(request):
        raise httpx.ConnectError("down")

    assert _client(handler).report(DECISION, TX, True) is False


def test_the_payee_is_the_service_not_the_address():
    assert payee_of(RES, VENDOR) == "acr.example"
    assert payee_of("", VENDOR) == ""
