"""The Spend Statement — and the dollar figure that must never appear on it.

The headline test is ``test_the_indexs_dollar_figure_never_reaches_the_owner``.
``payer_tca`` returns ``overpaid_usdc``, derived from slippage against the ACR
arrival print, whose reference level ``anchors/GAP.md`` records as 20x to 1159x
off real market prices. The bp figures from that call are scale-invariant and
fine; the USDC one is a real number about a synthetic scale, and on an owner's
page it would read as money.
"""

from __future__ import annotations

import json

import pytest
from index_api.businesses import Business
from index_api.statement import build_statement, read_decisions, summarise

A = "0x" + "aa" * 20
VENDOR = "0x" + "bb" * 20
NOW = 1_790_000_000.0

ACME = Business(
    slug="acme", treasury=A, name="Acme Ltd", consented=True, tier="network",
    chain="testnet", categories=("infra",), policy_wallet="0x" + "cc" * 20,
)
MEASURED = Business(slug="eval", treasury="0x" + "dd" * 20, tier="network")
REG = (ACME, MEASURED)


def _row(**kw):
    base = dict(
        at=NOW - 100, obligation_id="ob", vendor=VENDOR, category="infra",
        billed_usdc=1.0, intent="pay", rule="at par", business="acme",
    )
    base.update(kw)
    return base


def _log(tmp_path, rows):
    p = tmp_path / "decisions.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return str(p)


def _tca(card):
    def fn(payer, days=7):
        return card
    return fn


class _Pol:
    def __init__(self, budgets):
        self._b = budgets

    def budget(self, category):
        return self._b.get(category)


# --- the separation this file exists to enforce ----------------------------

def test_the_indexs_dollar_figure_never_reaches_the_owner(tmp_path):
    card = {
        "available": True,
        "purchases": 12,
        "benchmarked": 10,
        "spent_usdc": 4.0,
        "vw_slippage_bp": 130.0,
        # The number that must not be forwarded. A value that cannot collide
        # with a timestamp or a count, so the scan below means what it says.
        "overpaid_usdc": 424_242.42,
    }
    st = build_statement(
        "acme", registry=REG, tca_fn=_tca(card),
        log_path=_log(tmp_path, [_row()]), now=NOW,
    )

    blob = json.dumps(st)
    assert "overpaid_usdc" not in blob, "an index-scaled dollar figure reached the statement"
    assert "424242.42" not in blob, "the value leaked under another key"

    ctx = st["market_context"]
    assert ctx["available"] is True
    assert ctx["vw_slippage_bp"] == 130.0, "bp is scale-invariant and does survive"
    assert "bp only" in ctx["basis"]
    assert "anchors/GAP.md" in ctx["note"], "the page says where to check the claim"


def test_the_only_dollar_saving_comes_from_a_named_cheaper_seller(tmp_path):
    """A reroute names a seller who was offering the same service for less. An
    escalation might save more and might save nothing, and which it was is not
    known until a human acts."""
    rows = [
        _row(intent="reroute", saving_usdc=3.0),
        _row(intent="reroute", saving_usdc=1.5),
        _row(intent="escalate", saving_usdc=1_000.0, rule="over par, no alternative"),
        _row(intent="pay", paid_usdc=2.0),
    ]
    s = summarise(rows)
    assert s["saved_usdc"] == pytest.approx(4.5), "escalations contribute nothing"
    assert s["paid_usdc"] == pytest.approx(2.0)


def test_market_context_is_absent_rather_than_zero_when_there_is_no_tape(tmp_path):
    st = build_statement(
        "acme", registry=REG, tca_fn=_tca({"available": False, "reason": "NO_TAPE"}),
        log_path=_log(tmp_path, [_row()]), now=NOW,
    )
    assert st["market_context"]["available"] is False
    assert st["market_context"]["reason"] == "NO_TAPE"
    assert "vw_slippage_bp" not in st["market_context"]


def test_without_a_tca_source_the_statement_still_stands(tmp_path):
    """The savings are the operator's own; the index is context. Losing the
    subgraph must not blank the page."""
    st = build_statement("acme", registry=REG, log_path=_log(tmp_path, [_row()]), now=NOW)
    assert st["market_context"]["available"] is False
    assert st["spend"]["decisions"] == 1


# --- whose decisions, and when --------------------------------------------

def test_an_unknown_business_has_no_statement():
    assert build_statement("nobody", registry=REG) is None


def test_a_statement_resolves_by_address_as_well_as_slug(tmp_path):
    st = build_statement("acme", registry=REG, log_path=_log(tmp_path, [_row()]), now=NOW)
    by_addr = build_statement(A, registry=REG, log_path=_log(tmp_path, [_row()]), now=NOW)
    assert st["business"]["slug"] == by_addr["business"]["slug"] == "acme"


def test_one_businesss_statement_never_shows_anothers_decisions(tmp_path):
    """The log is shared; the statement is not. This is the whole of
    multi-tenancy on the read side."""
    path = _log(tmp_path, [
        _row(business="acme", billed_usdc=1.0),
        _row(business="rival", billed_usdc=500.0),
        _row(business="acme", billed_usdc=2.0),
    ])
    st = build_statement("acme", registry=REG, log_path=path, now=NOW)
    assert st["spend"]["decisions"] == 2
    assert all(r["business"] == "acme" for r in st["recent"])


def test_decisions_outside_the_period_are_not_counted(tmp_path):
    path = _log(tmp_path, [
        _row(at=NOW - 100),
        _row(at=NOW - 60 * 86_400),  # well outside a 7-day window
    ])
    st = build_statement("acme", registry=REG, log_path=path, days=7, now=NOW)
    assert st["spend"]["decisions"] == 1


def test_escalations_are_listed_newest_first_because_that_is_the_queue(tmp_path):
    path = _log(tmp_path, [
        _row(at=NOW - 300, intent="escalate", obligation_id="old", rule="limit hit"),
        _row(at=NOW - 100, intent="escalate", obligation_id="new", rule="limit hit"),
        _row(at=NOW - 200, intent="pay"),
    ])
    st = build_statement("acme", registry=REG, log_path=path, now=NOW)
    assert [e["obligation_id"] for e in st["escalations"]] == ["new", "old"]


# --- the log is read defensively ------------------------------------------

def test_a_missing_log_is_no_decisions_not_an_error():
    assert read_decisions("/no/such/log.jsonl") == []


def test_a_torn_line_does_not_truncate_the_history_behind_it(tmp_path):
    """An interrupted write leaves half a line. Treating that as end-of-file
    would silently drop every decision after it."""
    p = tmp_path / "decisions.jsonl"
    p.write_text(
        json.dumps(_row(obligation_id="first")) + "\n"
        + '{"at": 1, "intent": "pa\n'
        + json.dumps(_row(obligation_id="third")) + "\n"
    )
    rows = read_decisions(str(p), business="acme")
    assert [r["obligation_id"] for r in rows] == ["first", "third"]


def test_blank_lines_are_not_decisions(tmp_path):
    p = tmp_path / "decisions.jsonl"
    p.write_text("\n\n" + json.dumps(_row()) + "\n\n")
    assert len(read_decisions(str(p), business="acme")) == 1


# --- what the owner is asked to act on ------------------------------------

def test_decided_and_escalated_are_two_numbers_not_a_ratio(tmp_path):
    """A ratio hides how much the agent actually did, and the interesting
    failure is a high ratio over three decisions."""
    rows = [_row(intent="pay")] * 7 + [_row(intent="escalate")] * 3
    s = summarise(rows)
    assert s["decided"] == 7
    assert s["escalated"] == 3
    assert "escalation_rate" not in s


def test_a_hold_and_a_refusal_are_decisions_the_agent_made(tmp_path):
    rows = [_row(intent="hold"), _row(intent="refuse"), _row(intent="escalate")]
    s = summarise(rows)
    assert s["decided"] == 2, "holding and refusing are decisions, not failures"
    assert s["escalated"] == 1


def test_only_an_overbill_counts_as_a_discrepancy(tmp_path):
    """A vendor who billed for less than we counted is not a discrepancy worth
    reporting as one."""
    rows = [
        _row(discrepancy=100.0),   # they billed more
        _row(discrepancy=-50.0),   # they billed less
        _row(discrepancy=0.0),
    ]
    assert summarise(rows)["consumption_discrepancies"] == 1


def test_unmetered_bills_are_counted_separately_from_overbills(tmp_path):
    rows = [
        _row(intent="escalate", rule="unmetered: we hold no record of consuming this"),
        _row(intent="escalate", rule="metered below billed: they billed 10, we counted 1",
             discrepancy=9.0),
    ]
    s = summarise(rows)
    assert s["unmetered"] == 1
    assert s["consumption_discrepancies"] == 1


# --- budgets come from the contract ---------------------------------------

def test_a_business_being_measured_shows_no_budgets_and_says_so(tmp_path):
    """No PolicyWallet is a real state: the operator can price and meter for
    them but cannot spend."""
    st = build_statement("eval", registry=REG, log_path=_log(tmp_path, [_row()]), now=NOW)
    assert st["spends"] is False
    assert st["budgets"] == []


def test_a_category_with_no_on_chain_budget_is_flagged_not_omitted(tmp_path):
    """Omitting it would read as 'this business has no infra spend', when in
    fact nobody has configured the budget yet."""
    st = build_statement(
        "acme", registry=REG, policy_for=lambda b: _Pol({}),
        log_path=_log(tmp_path, [_row()]), now=NOW,
    )
    assert st["budgets"] == [{"category": "infra", "configured": False}]


def test_a_configured_budget_is_reported_as_the_contract_states_it(tmp_path):
    live = {
        "category": "infra", "cap_usdc": 1_000.0, "spent_usdc": 12.0,
        "remaining_usdc": 988.0, "per_tx_limit_usdc": 100.0,
        "period_start": 1, "period_length": 2,
    }
    st = build_statement(
        "acme", registry=REG, policy_for=lambda b: _Pol({"infra": live}),
        log_path=_log(tmp_path, [_row()]), now=NOW,
    )
    assert st["budgets"][0]["configured"] is True
    assert st["budgets"][0]["remaining_usdc"] == pytest.approx(988.0)


# --- the business block ----------------------------------------------------

def test_an_unconsented_business_is_not_named_on_its_own_statement(tmp_path):
    st = build_statement("eval", registry=REG, log_path=_log(tmp_path, [_row()]), now=NOW)
    assert st["business"]["label"] == "business eval"
    assert "name" not in st["business"]


# --- the queue clears when a person acts -----------------------------------

def test_an_approved_escalation_leaves_the_queue(tmp_path):
    """The log is append-only, so approving appends a payment rather than editing
    the escalation. A queue filtering on intent alone would keep showing an
    obligation the owner paid an hour ago."""
    path = _log(tmp_path, [
        _row(at=NOW - 300, intent="escalate", obligation_id="inv-1", rule="limit hit"),
        _row(at=NOW - 200, intent="escalate", obligation_id="inv-2", rule="limit hit"),
        _row(at=NOW - 100, intent="pay", obligation_id="inv-1",
             rule="owner approved", paid_usdc=5.0),
    ])
    st = build_statement("acme", registry=REG, log_path=path, now=NOW)
    assert [e["obligation_id"] for e in st["escalations"]] == ["inv-2"]


def test_a_rejected_escalation_also_leaves_the_queue(tmp_path):
    """Refusing is a decision. An item a person has dealt with is dealt with,
    whichever way they went."""
    path = _log(tmp_path, [
        _row(at=NOW - 300, intent="escalate", obligation_id="inv-1", rule="limit hit"),
        _row(at=NOW - 100, intent="refuse", obligation_id="inv-1", rule="owner rejected"),
    ])
    st = build_statement("acme", registry=REG, log_path=path, now=NOW)
    assert st["escalations"] == []


def test_re_escalating_the_same_bill_is_one_item_of_work(tmp_path):
    """A retry that stopped again is the same invoice, not two things to read."""
    path = _log(tmp_path, [
        _row(at=NOW - 300, intent="escalate", obligation_id="inv-1", rule="first stop"),
        _row(at=NOW - 100, intent="escalate", obligation_id="inv-1", rule="stopped again"),
    ])
    st = build_statement("acme", registry=REG, log_path=path, now=NOW)
    assert len(st["escalations"]) == 1
    assert st["escalations"][0]["rule"] == "stopped again", "the newest reading"


def test_an_unresolved_escalation_stays_until_somebody_acts(tmp_path):
    path = _log(tmp_path, [
        _row(at=NOW - 300, intent="escalate", obligation_id="inv-1", rule="limit hit"),
        _row(at=NOW - 100, intent="pay", obligation_id="inv-OTHER", rule="at par"),
    ])
    st = build_statement("acme", registry=REG, log_path=path, now=NOW)
    assert [e["obligation_id"] for e in st["escalations"]] == ["inv-1"]


# --- the two tiers ---------------------------------------------------------

def test_the_committed_archive_and_the_live_log_are_read_together(tmp_path, monkeypatch):
    """`data/` is untracked and dockerignored, so a log written only there is
    present in development and absent in production. The archive ships in the
    image; the live log accumulates beside it. Same two-tier shape the receipts
    use, for the same reason."""
    from index_api import statement as st_mod

    archive = tmp_path / "archive.jsonl"
    archive.write_text(json.dumps(_row(obligation_id="old", intent="pay")) + "\n")
    live = tmp_path / "live.jsonl"
    live.write_text(json.dumps(_row(obligation_id="new", intent="reroute")) + "\n")

    monkeypatch.setattr(st_mod, "ARCHIVE_PATH", archive)
    monkeypatch.setattr(st_mod, "LOG_PATH", str(live))

    rows = read_decisions(business="acme")
    assert [r["obligation_id"] for r in rows] == ["old", "new"]


def test_a_row_in_both_tiers_is_one_decision(tmp_path, monkeypatch):
    """What rotation produces. Deduped on the row's whole content, because a
    guessed composite key merged two genuinely different decisions once."""
    from index_api import statement as st_mod

    row = _row(obligation_id="same")
    archive = tmp_path / "archive.jsonl"
    archive.write_text(json.dumps(row) + "\n")
    live = tmp_path / "live.jsonl"
    live.write_text(json.dumps(row) + "\n")

    monkeypatch.setattr(st_mod, "ARCHIVE_PATH", archive)
    monkeypatch.setattr(st_mod, "LOG_PATH", str(live))
    assert len(read_decisions(business="acme")) == 1


def test_two_decisions_that_differ_only_in_amount_are_both_kept(tmp_path, monkeypatch):
    """The failure the content key exists to avoid: same obligation, same
    instant, same intent, different money. Collapsing those loses a decision,
    which is worse than showing a duplicate."""
    from index_api import statement as st_mod

    a = _row(obligation_id="x", billed_usdc=1.0)
    b = _row(obligation_id="x", billed_usdc=2.0)
    live = tmp_path / "live.jsonl"
    live.write_text(json.dumps(a) + "\n" + json.dumps(b) + "\n")

    monkeypatch.setattr(st_mod, "ARCHIVE_PATH", tmp_path / "absent.jsonl")
    monkeypatch.setattr(st_mod, "LOG_PATH", str(live))
    assert len(read_decisions(business="acme")) == 2


def test_an_explicit_path_reads_only_that_file(tmp_path, monkeypatch):
    """Tests and one-off inspections want exactly what they name."""
    from index_api import statement as st_mod

    monkeypatch.setattr(
        st_mod, "ARCHIVE_PATH", tmp_path / "should-not-be-read.jsonl"
    )
    (tmp_path / "should-not-be-read.jsonl").write_text(
        json.dumps(_row(obligation_id="archive")) + "\n"
    )
    only = _log(tmp_path, [_row(obligation_id="named")])
    rows = read_decisions(only, business="acme")
    assert [r["obligation_id"] for r in rows] == ["named"]


def test_the_shipped_decision_archive_is_valid_and_real():
    """The committed archive must parse, and every row must carry the rule that
    produced it. A decision archive that fails to load in production looks
    exactly like an agent that has never decided anything."""
    rows = read_decisions(str(__import__("index_api.statement", fromlist=["x"]).ARCHIVE_PATH))
    for r in rows:
        assert r.get("rule"), r
        assert r.get("business"), r
        assert r.get("intent") in {"pay", "hold", "reroute", "escalate", "refuse"}, r
    # Every saving must name the seller it was measured against, or it is a
    # number nobody can check.
    for r in rows:
        if (r.get("saving_usdc") or 0) > 0:
            assert r.get("reroute_to"), r
