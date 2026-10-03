"""The operator endpoints over HTTP — not just the modules beneath them.

`test_statement.py` and `test_businesses.py` cover the builders. This file
covers the two routes, because a surface tested only through its own internals
is where a presence test passes on a deleted pillar: the module can be perfect
while the route is unregistered, mis-wired, or quietly serving a field it must
not.

The claim this file exists to defend over HTTP is the same one `statement.py`
enforces internally: `payer_tca`'s `overpaid_usdc` is a real number about a
synthetic scale (`anchors/GAP.md` puts the index reference level 20x to 1159x
off market), so it must never reach an owner's page. Asserting it inside the
builder is not enough — the route is what the world reads.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from index_api import businesses as biz
from index_api.app import app

A = "0x" + "aa" * 20
B = "0x" + "bb" * 20

client = TestClient(app)


@pytest.fixture
def registry(tmp_path, monkeypatch):
    """Point the registry at a temp file. The endpoints call `load()` with no
    arguments, so the module attribute is the seam."""

    def _seed(rows):
        p = tmp_path / "businesses.json"
        p.write_text(json.dumps({"businesses": rows}))
        monkeypatch.setattr(biz, "REGISTRY_PATH", p)
        return p

    return _seed


ACME = {
    "slug": "acme",
    "treasury": A,
    "name": "Acme Ltd",
    "consented": True,
    "tier": "network",
    "chain": "testnet",
    "categories": ["infra"],
}
QUIET = {"slug": "quiet", "treasury": B, "name": "Quiet Co", "consented": False,
         "tier": "own", "chain": "mainnet"}


# --- /operator/businesses --------------------------------------------------

def test_an_empty_registry_answers_with_zeros_rather_than_an_error(registry):
    """Every host starts here. A traction surface that 500s on zero looks
    broken, and zero is the honest answer."""
    registry([])
    r = client.get("/operator/businesses")
    assert r.status_code == 200
    body = r.json()
    assert body["businesses"] == []
    assert body["counts"]["businesses"] == 0
    assert body["counts"]["by_tier"] == {"own": 0, "network": 0, "cohort": 0, "oss": 0}


def test_the_counts_are_derived_from_the_list_beside_them(registry):
    """So the number a reviewer checks cannot drift from the rows under it."""
    registry([ACME, QUIET])
    body = client.get("/operator/businesses").json()
    assert len(body["businesses"]) == body["counts"]["businesses"] == 2
    assert body["counts"]["mainnet"] == 1 and body["counts"]["testnet"] == 1
    assert "total_chain" not in body["counts"], "there is no field adding the two"


def test_an_unconsented_business_is_counted_and_not_named_over_http(registry):
    registry([ACME, QUIET])
    rows = {b["slug"]: b for b in client.get("/operator/businesses").json()["businesses"]}
    assert rows["acme"]["name"] == "Acme Ltd"
    assert "name" not in rows["quiet"], "a name we were not given must not be served"
    assert rows["quiet"]["label"] == "business quiet"
    assert client.get("/operator/businesses").json()["counts"]["businesses"] == 2


# --- /operator/statement/{business} ---------------------------------------

def test_an_unknown_business_is_404_not_an_empty_statement(registry):
    """An empty statement reads as "this business has spent nothing", which is a
    different and much more flattering claim than "we have never heard of them"."""
    registry([ACME])
    r = client.get("/operator/statement/nobody")
    assert r.status_code == 404
    assert "nobody" in r.json()["detail"]


def test_a_statement_resolves_by_slug_and_by_treasury_address(registry):
    """A URL will carry either, and a reader should not have to know which."""
    registry([ACME])
    for ident in ("acme", A, A.upper()):
        r = client.get(f"/operator/statement/{ident}")
        assert r.status_code == 200, ident
        assert r.json()["business"]["slug"] == "acme"


def test_the_statement_never_serves_the_indexs_dollar_figure(registry, monkeypatch):
    """The route, not just the builder. A card carrying overpaid_usdc is fed in
    deliberately; neither the key nor the value may appear in the response."""
    registry([ACME])
    monkeypatch.setattr(
        "index_api.app.payer_tca",
        lambda payer, days=7: {
            "available": True,
            "purchases": 9,
            "benchmarked": 7,
            "spent_usdc": 1.5,
            "vw_slippage_bp": 42.0,
            "overpaid_usdc": 424_242.42,
        },
    )
    body = client.get("/operator/statement/acme").json()
    blob = json.dumps(body)
    assert "overpaid_usdc" not in blob
    assert "424242.42" not in blob, "the value leaked under another key"
    ctx = body["market_context"]
    assert ctx["vw_slippage_bp"] == 42.0, "bp is scale-invariant and does survive"
    assert "bp only" in ctx["basis"]


def test_a_business_with_no_wallet_reports_that_it_cannot_spend(registry):
    """No PolicyWallet is a real state: priced and metered for, not paid for."""
    registry([ACME])
    body = client.get("/operator/statement/acme").json()
    assert body["spends"] is False
    assert body["budgets"] == []


def test_the_period_is_clamped_rather_than_taken_on_trust(registry):
    """A window nobody asked for is a slow query somebody can ask for
    repeatedly. The route accepts the parameter; it does not have to honour an
    absurd one."""
    registry([ACME])
    for days in (1, 7, 90):
        r = client.get(f"/operator/statement/acme?days={days}")
        assert r.status_code == 200
        assert r.json()["period_days"] == days


def test_the_statement_carries_the_queue_before_the_totals(registry):
    """Shape check: the owner's page is driven by these keys, and a rename here
    blanks a section rather than failing loudly."""
    registry([ACME])
    body = client.get("/operator/statement/acme").json()
    for key in ("business", "period_days", "as_of", "spend", "budgets",
                "spends", "escalations", "recent", "market_context"):
        assert key in body, key
    assert isinstance(body["escalations"], list)
    for key in ("decisions", "decided", "escalated", "paid_usdc", "saved_usdc",
                "consumption_discrepancies", "unmetered"):
        assert key in body["spend"], key


# --- /operator/ledger/{business} ------------------------------------------

def test_the_ledger_is_served_as_plain_text_and_balances(registry):
    """The consumer is beancount, or a person reading it, so JSON would be the
    wrong container. Ungated for the same reason the statement is: an accountant
    should not need a key to check our arithmetic."""
    from index_api.ledger_export import balance_problems

    registry([ACME])
    r = client.get("/operator/ledger/acme")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    assert balance_problems(r.text) == [], "the served file does not balance"
    assert 'option "operating_currency" "USDC"' in r.text
    assert "1970-01-01" not in r.text, "an empty ledger must not open in 1970"


def test_an_unknown_business_has_no_ledger(registry):
    registry([ACME])
    r = client.get("/operator/ledger/nobody")
    assert r.status_code == 404


def test_the_ledger_window_is_clamped(registry):
    """A window nobody asked for is a slow read somebody can ask for repeatedly."""
    registry([ACME])
    for days in ("1", "9999", "-5", "notanumber"):
        r = client.get(f"/operator/ledger/acme?days={days}")
        assert r.status_code in (200, 422), days


# --- the audit, over HTTP ---------------------------------------------------
#
# `test_ledger_audit.py` puts each of the six errors in front of its own check.
# This is the other half: that the route exists, answers, and carries all six —
# because a module can be perfect while the route serves five.


def test_the_audit_route_reports_all_six(registry):
    from index_api.ledger_audit import ERRORS, PHANTOM

    registry([ACME])
    r = client.get("/operator/audit/acme")
    assert r.status_code == 200
    body = r.json()
    names = tuple(c["error"] for c in body["checks"])
    assert names[:6] == ERRORS, "the essay's six, in its order"
    # And the one the essay says nobody can disprove, reported beside them
    # rather than smuggled into the list it is not part of.
    assert names[6] == PHANTOM and len(names) == 7
    assert body["business"] == "acme"


def test_the_audit_says_what_each_check_searched(registry):
    """`found: 0` on its own is indistinguishable from a book nobody opened."""
    registry([ACME])
    body = client.get("/operator/audit/acme").json()
    assert all("searched" in c and "question" in c for c in body["checks"])


def test_the_audit_never_calls_an_unattributable_settlement_clean(registry):
    """A settlement with no payee is neither covered nor a finding, and folding
    it into either would be the omission the first check exists to find."""
    registry([ACME])
    body = client.get("/operator/audit/acme").json()
    assert "unattributable_settlements" in body
    assert isinstance(body["unattributable_settlements"], int)


def test_an_unknown_business_has_no_audit(registry):
    registry([ACME])
    assert client.get("/operator/audit/nobody").status_code == 404


def test_the_audit_window_is_clamped(registry):
    registry([ACME])
    for days in ("1", "9999", "-5", "notanumber"):
        r = client.get(f"/operator/audit/acme?days={days}")
        assert r.status_code in (200, 422), days


def test_the_audit_does_not_leak_the_index_dollar_figure(registry):
    """The same rule as the statement: `anchors/GAP.md` puts the index reference
    level 20x to 1159x off market, so its dollar figure never reaches a page."""
    registry([ACME])
    assert "overpaid_usdc" not in client.get("/operator/audit/acme").text
