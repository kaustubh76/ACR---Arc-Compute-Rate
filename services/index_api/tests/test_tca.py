"""TCA + rating tests — the arithmetic, and the honesty of what it will not claim."""

from __future__ import annotations

import pytest
from index_api import tca as tca_mod
from index_api.tca import MIN_RATED_N, WEIGHTS, _grade, _p50_bp, _reroute, _vw_bp

SELLER = "0x" + "22" * 20
OTHER = "0x" + "33" * 20
PAYER = "0x" + "11" * 20


# --- arithmetic --------------------------------------------------------------


def test_volume_weighted_slippage_divides_the_tenth_bp_figure():
    # 100 USDC-1e6 of volume carrying 1000 tenth-bp == 100 bp.
    assert _vw_bp(100 * 1000, 100) == pytest.approx(100.0)


def test_no_benchmarked_volume_is_none_not_zero():
    """Zero bp means 'paid exactly the benchmark'. None means 'nothing to
    compare'. A surface that renders the second as the first is lying."""
    assert _vw_bp(0, 0) is None


def test_p50_interpolates_inside_a_bucket():
    # 10 settlements all in b3 ([50, 100)); the median sits mid-bucket.
    assert _p50_bp([0, 0, 0, 10, 0, 0, 0]) == pytest.approx(75.0)


def test_p50_splits_across_buckets():
    # 10 in b2 ([0,50)) and 10 in b3 ([50,100)) → the median lands on the seam.
    assert _p50_bp([0, 0, 10, 10, 0, 0, 0]) == pytest.approx(50.0)


def test_p50_reports_an_open_tail_at_its_edge_rather_than_inventing_an_interior():
    assert _p50_bp([10, 0, 0, 0, 0, 0, 0]) == -100.0
    assert _p50_bp([0, 0, 0, 0, 0, 0, 10]) == 500.0


def test_p50_of_an_empty_histogram_is_none():
    assert _p50_bp([0] * 7) is None


# --- grading -----------------------------------------------------------------


def test_grade_boundaries():
    assert _grade(0.95) == "A"
    assert _grade(0.85) == "A"
    assert _grade(0.84) == "B"
    assert _grade(0.70) == "B"
    assert _grade(0.50) == "C"
    assert _grade(0.49) == "D"
    assert _grade(None) == "Unrated"


def test_the_published_weights_sum_to_one_hundred():
    assert sum(WEIGHTS.values()) == 100


# --- the wire ----------------------------------------------------------------


def _fake_graph(monkeypatch, payload: dict):
    monkeypatch.setattr(tca_mod, "_cfg", lambda: ("https://example.invalid", ""))
    monkeypatch.setattr(tca_mod, "graph_query", lambda *a, **k: payload)


def _seller_day(**over) -> dict:
    row = {
        "day": 20660, "volume": "1000000", "bmVolume": "1000000",
        "wSlipTenthBp": "1000000000",  # 1000 tenth-bp × 1e6 volume == 100 bp
        "humanVolume": "0", "synthVolume": "1000000", "realVolume": "0",
        "n": 25, "nAll": 25, "nStale": 0,
        "b0": 0, "b1": 0, "b2": 0, "b3": 0, "b4": 25, "b5": 0, "b6": 0,
    }
    row.update(over)
    return row


def test_a_rating_carries_n_and_the_synthetic_share(monkeypatch):
    """Every card, always — a grade without them invites being read as a claim
    about a market rather than about our own testnet flow."""
    _fake_graph(monkeypatch, {"sellerDays": [_seller_day()], "seller": {"id": SELLER}})
    r = tca_mod.seller_rating(SELLER)
    assert r["available"] is True
    assert r["n"] == 25
    assert r["synthetic_share"] == 1.0
    assert r["components"]["fairness"]["vw_slippage_bp"] == pytest.approx(100.0)


def test_a_thin_tape_is_unrated_with_the_reason(monkeypatch):
    _fake_graph(monkeypatch, {"sellerDays": [_seller_day(n=5, nAll=5)], "seller": {"id": SELLER}})
    r = tca_mod.seller_rating(SELLER)
    assert r["grade"] == "Unrated"
    assert f"n=5 < {MIN_RATED_N}" in r["unrated_reason"]


def test_unsupported_components_are_excluded_from_the_weight_not_scored_zero(monkeypatch):
    """A seller must not be marked down for a signal ACR has not started
    collecting. The card says what share of the methodology the grade rests on."""
    _fake_graph(monkeypatch, {"sellerDays": [_seller_day()], "seller": {"id": SELLER}})
    r = tca_mod.seller_rating(SELLER)
    assert r["components"]["cleanliness"]["available"] is False
    assert r["components"]["human_depth"]["available"] is False
    # Only fairness is supported here, so the grade rests on 40 of 100.
    assert r["weight_covered_pct"] == WEIGHTS["fairness"]
    # …and it is a real grade, not a zero dragged down by the missing 60.
    assert r["grade"] in {"A", "B", "C", "D"}


def _seller_window(**over) -> dict:
    win = {"window": 2951, "distinctPayers": 2, "distinctHumans": 1,
           "volume": "1000000", "humanVolume": "500000"}
    win.update(over)
    return win


def test_human_depth_counts_a_fleet_once(monkeypatch):
    """Two wallets, one verified human. The component's whole reason to exist is
    that those are different numbers — a seller that has met one person is not
    one that has met two."""
    _fake_graph(monkeypatch, {
        "sellerDays": [_seller_day(humanVolume="500000")],
        "seller": {"id": SELLER},
        "sellerWindow": _seller_window(),
    })
    r = tca_mod.seller_rating(SELLER)
    depth = r["components"]["human_depth"]
    assert depth["available"] is True
    assert depth["distinct_humans"] == 1
    assert depth["distinct_payers"] == 2
    assert depth["score"] == pytest.approx(0.5)
    assert depth["human_volume_share"] == pytest.approx(0.5)
    # The grade now rests on fairness AND human depth, and says so.
    assert r["weight_covered_pct"] == WEIGHTS["fairness"] + WEIGHTS["human_depth"]


def test_human_depth_is_refused_rather_than_blended_over_a_longer_window(monkeypatch):
    """A cluster id is minted per rotation window, so distinct humans cannot be
    summed across windows. Serving a 30d fairness beside a 7d human depth would
    be one grade quietly built out of two different spans."""
    _fake_graph(monkeypatch, {
        "sellerDays": [_seller_day()],
        "seller": {"id": SELLER},
        "sellerWindow": _seller_window(),
    })
    r = tca_mod.seller_rating(SELLER, days=30)
    depth = r["components"]["human_depth"]
    assert depth["available"] is False
    assert "rotation window" in depth["reason"]
    assert r["weight_covered_pct"] == WEIGHTS["fairness"]


def test_a_window_with_no_resolutions_is_unavailable_not_zero(monkeypatch):
    """Nobody resolved is not the same fact as nobody human, and a seller must
    not be marked down for the difference."""
    _fake_graph(monkeypatch, {
        "sellerDays": [_seller_day()],
        "seller": {"id": SELLER},
        "sellerWindow": _seller_window(distinctHumans=0, humanVolume="0"),
    })
    depth = tca_mod.seller_rating(SELLER)["components"]["human_depth"]
    assert depth["available"] is False
    assert "this window" in depth["reason"]


def test_a_seller_paying_the_benchmark_exactly_grades_top(monkeypatch):
    _fake_graph(
        monkeypatch,
        {"sellerDays": [_seller_day(wSlipTenthBp="0", b4=0, b2=25)], "seller": {"id": SELLER}},
    )
    assert tca_mod.seller_rating(SELLER)["grade"] == "A"


def test_an_unreachable_subgraph_says_so(monkeypatch):
    _fake_graph(monkeypatch, {})
    r = tca_mod.seller_rating(SELLER)
    assert r["available"] is False and "did not answer" in r["reason"]


def test_payer_tca_breaks_down_by_seller_and_ranks_worst_first(monkeypatch):
    _fake_graph(monkeypatch, {
        "payerDays": [{
            "day": 20660, "spent": "2000000", "bmSpent": "2000000",
            "wSlipTenthBp": "2000000000", "overpay": "20000", "n": 2, "nAll": 2,
        }],
        "settlements": [
            {"seller": {"id": SELLER}, "amount": "1000000",
             "slippageTenthBp": "1880", "synthetic": True, "index": "ACR-INF"},
            {"seller": {"id": OTHER}, "amount": "1000000",
             "slippageTenthBp": "-120", "synthetic": True, "index": "ACR-INF"},
        ],
    })
    r = tca_mod.payer_tca(PAYER)
    assert r["purchases"] == 2 and r["benchmarked"] == 2
    assert r["spent_usdc"] == pytest.approx(2.0)
    assert r["by_seller"][0]["seller"] == SELLER  # worst first
    assert r["by_seller"][0]["vw_slippage_bp"] == pytest.approx(188.0)
    assert r["by_seller"][-1]["vw_slippage_bp"] == pytest.approx(-12.0)


def test_the_reroute_names_both_sides_and_calls_itself_a_suggestion(monkeypatch):
    _fake_graph(monkeypatch, {
        "payerDays": [{
            "day": 20660, "spent": "2000000", "bmSpent": "2000000",
            "wSlipTenthBp": "2000000000", "overpay": "20000", "n": 2, "nAll": 2,
        }],
        "settlements": [
            {"seller": {"id": SELLER}, "amount": "1000000",
             "slippageTenthBp": "1880", "synthetic": True, "index": "ACR-INF"},
            {"seller": {"id": OTHER}, "amount": "1000000",
             "slippageTenthBp": "-120", "synthetic": True, "index": "ACR-INF"},
        ],
    })
    rr = tca_mod.payer_tca(PAYER)["reroute"]
    assert rr["from"] == SELLER and rr["to"] == OTHER
    assert rr["saving_bp"] == pytest.approx(200.0)
    assert rr["note"] == "a suggestion, not a promise"


def test_no_reroute_when_there_is_nothing_to_reroute_to():
    assert _reroute([{"seller": SELLER, "vw_slippage_bp": 10.0, "n": 4, "volume_usdc": 1.0}]) is None


def test_no_reroute_when_the_cheapest_seller_is_the_one_already_used():
    same = [
        {"seller": SELLER, "vw_slippage_bp": 10.0, "n": 4, "volume_usdc": 1.0},
        {"seller": OTHER, "vw_slippage_bp": 10.0, "n": 4, "volume_usdc": 1.0},
    ]
    assert _reroute(same) is None
