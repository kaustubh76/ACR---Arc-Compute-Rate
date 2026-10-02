"""The traction numbers — and the one claim this file refuses to make.

`test_historical_spend_is_not_counted_as_value_the_agent_moved`. The fleet's
0.325 USDC of settlements were paid by the buyer agent before the operator
existed. Counting them as "value the agent moved" is the most tempting lie
available on a traction page, and it would be a lie: the operator priced them,
it did not pay them.

Everything else here guards the same property — a figure must be derived from
rows a reader can open, so it cannot drift from them.
"""

from __future__ import annotations

import json

import pytest
from index_api import businesses as biz
from index_api import statement as st_mod
from index_api.traction import build_traction

A = "0x" + "aa" * 20
B = "0x" + "bb" * 20
NOW = 1_790_000_000.0


def _row(**kw):
    base = dict(
        at=NOW - 100, obligation_id="ob", vendor="0x" + "cc" * 20, category="infra",
        billed_usdc=1.0, intent="pay", rule="at par", business="acme", paid_usdc=0.0,
    )
    base.update(kw)
    return base


@pytest.fixture
def wired(tmp_path, monkeypatch):
    def seed(businesses, decisions):
        reg = tmp_path / "businesses.json"
        reg.write_text(json.dumps({"businesses": businesses}))
        monkeypatch.setattr(biz, "REGISTRY_PATH", reg)
        log = tmp_path / "live.jsonl"
        log.write_text("\n".join(json.dumps(d) for d in decisions) + "\n")
        monkeypatch.setattr(st_mod, "LOG_PATH", str(log))
        monkeypatch.setattr(st_mod, "ARCHIVE_PATH", tmp_path / "absent.jsonl")
    return seed


ACME = {"slug": "acme", "treasury": A, "name": "Acme", "consented": True,
        "tier": "network", "chain": "testnet", "categories": ["infra"]}
BIGCO = {"slug": "bigco", "treasury": B, "tier": "own", "chain": "mainnet",
         "policy_wallet": "0x" + "dd" * 20}


# --- the claim this page will not make ------------------------------------

def test_historical_spend_is_not_counted_as_value_the_agent_moved(wired):
    """Assessed is not paid. `priced_usdc` is real work on real bills;
    `moved_usdc` is money this operator sent, and a dry run sent none."""
    wired([ACME], [
        _row(billed_usdc=0.2, paid_usdc=0.0),   # cleared policy, never sent
        _row(billed_usdc=0.1, paid_usdc=0.0, intent="reroute", saving_usdc=0.05),
    ])
    t = build_traction(now=NOW)
    chain = t["by_chain"]["testnet"]
    assert chain["moved_usdc"] == 0.0, "nothing was sent, so nothing moved"
    assert chain["priced_usdc"] == pytest.approx(0.3), "but it was all assessed"
    assert chain["recoverable_usdc"] == pytest.approx(0.05)


def test_a_real_payment_does_count_as_moved(wired):
    wired([ACME], [_row(billed_usdc=2.0, paid_usdc=2.0, tx="0xabc")])
    assert build_traction(now=NOW)["by_chain"]["testnet"]["moved_usdc"] == pytest.approx(2.0)


def test_only_a_reroute_contributes_recoverable_overpay(wired):
    """An escalation might save more and might save nothing, and which it was is
    unknown until a human acts."""
    wired([ACME], [
        _row(intent="reroute", saving_usdc=1.0),
        _row(intent="escalate", saving_usdc=99.0),
    ])
    assert build_traction(now=NOW)["by_chain"]["testnet"]["recoverable_usdc"] == pytest.approx(1.0)


# --- the chains stay apart -------------------------------------------------

def test_mainnet_and_testnet_are_never_summed(wired):
    """Canteen say test USDC counts and mainnet counts more, which only means
    anything if the two are reported apart."""
    wired([ACME, BIGCO], [
        _row(business="acme", billed_usdc=1.0, paid_usdc=1.0),
        _row(business="bigco", billed_usdc=5.0, paid_usdc=5.0),
    ])
    t = build_traction(now=NOW)
    assert t["by_chain"]["testnet"]["moved_usdc"] == pytest.approx(1.0)
    assert t["by_chain"]["mainnet"]["moved_usdc"] == pytest.approx(5.0)
    assert "total" not in t and "all" not in t["by_chain"]
    blob = json.dumps(t)
    assert "6.0" not in blob, "the two chains were added together somewhere"


# --- derived, not maintained ----------------------------------------------

def test_every_figure_comes_from_rows_a_reader_can_open(wired):
    """A per-business ledger link is what makes the number checkable rather than
    asserted. Without it the page is a claim."""
    wired([ACME], [_row()])
    row = build_traction(now=NOW)["per_business"][0]
    assert row["ledger"] == "/operator/ledger/acme"
    assert row["statement"] == "/operator/statement/acme"


def test_the_counts_match_the_rows_beside_them(wired):
    wired([ACME, BIGCO], [_row(business="acme"), _row(business="bigco")])
    t = build_traction(now=NOW)
    assert t["businesses"]["businesses"] == len(t["per_business"]) == 2
    assert t["work"]["decisions"] == sum(r["decisions"] for r in t["per_business"])


def test_one_businesss_decisions_never_land_on_another(wired):
    # Distinct obligation ids: identical rows are one decision, by design, and
    # `read_decisions` dedupes on content for exactly that reason.
    wired([ACME, BIGCO],
          [_row(business="acme", obligation_id=f"a{i}") for i in range(3)]
          + [_row(business="bigco", obligation_id="b1")])
    rows = {r["slug"]: r for r in build_traction(now=NOW)["per_business"]}
    assert rows["acme"]["decisions"] == 3
    assert rows["bigco"]["decisions"] == 1


def test_an_unconsented_business_is_counted_and_not_named(wired):
    wired([BIGCO], [_row(business="bigco")])
    t = build_traction(now=NOW)
    assert t["businesses"]["businesses"] == 1
    assert t["per_business"][0]["label"] == "business bigco"
    assert "Acme" not in json.dumps(t)


def test_decided_and_escalated_stay_two_numbers(wired):
    wired([ACME],
          [_row(obligation_id=f"p{i}") for i in range(4)]
          + [_row(obligation_id=f"e{i}", intent="escalate") for i in range(2)])
    w = build_traction(now=NOW)["work"]
    assert w["decided"] == 4 and w["escalated"] == 2
    assert "escalation_rate" not in w


# --- zero -----------------------------------------------------------------

def test_an_empty_registry_reports_zeros_rather_than_nothing(wired):
    """A traction page that renders nothing for zero looks broken; zero is the
    honest answer and has to be sayable."""
    wired([], [])
    t = build_traction(now=NOW)
    assert t["businesses"]["businesses"] == 0
    assert t["per_business"] == []
    assert t["by_chain"] == {}
    assert t["work"]["decisions"] == 0


def test_a_business_with_no_decisions_yet_is_still_listed(wired):
    """Onboarded ten minutes ago is real onboarding."""
    wired([ACME], [])
    t = build_traction(now=NOW)
    assert len(t["per_business"]) == 1
    assert t["per_business"][0]["decisions"] == 0


def test_the_note_says_what_moved_means():
    """The distinction is load-bearing, so the payload explains it rather than
    leaving a reader to infer it."""
    note = build_traction()["note"]
    assert "paid out" in note and "assessed" in note
    assert "never summed" in note
