"""`GET /par` — the benchmark's first public surface.

`par.py` is 630 lines that, until this route, were reachable only by being in
`businesses.json`. The claim the route makes is the one RFB 3 names — "what the
market is actually paying" — so these tests are about WHICH market answered, and
about the refusals, rather than about the arithmetic (`test_par.py` has that).

The standing rule applies here as it does to the statement: the index's dollar
figure is a real number about a synthetic scale and must never reach a caller.
`anchors/GAP.md` puts the reference level 20x to 1250x off market.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from index_api.app import app
from index_api.par import FLEET_SELLERS

client = TestClient(app)

UNIT = "$/1k tokens"
STRANGER = "0x" + "9a" * 20


def _get(**q):
    r = client.get("/par", params=q)
    return r.status_code, r.json()


# --- which market answered --------------------------------------------------

def test_a_strangers_bill_is_priced_against_real_published_prices():
    """The whole point. Before the market basket a real invoice had no benchmark
    at this scale at all, and measuring it against the index would have read as
    roughly -9,990 bp — `par.py`'s own worked example."""
    status, j = _get(unit=UNIT, billed_usdc=0.02, quantity=10)
    assert status == 200
    assert j["benchmarked_against"] == "market"
    assert j["basket"]["index_id"] == "ACR-INF"
    assert j["basket"]["status"] == "ok"
    # Real prices are ~1/1000 of the index's reference level. If this ever
    # starts returning a par near 0.5 the fleet has leaked into the basket.
    assert j["par"]["par_usdc"] < 0.01, j["par"]
    assert j["par"]["sellers"] >= 2


def test_our_own_seller_is_priced_against_our_own_fleet():
    """Like-for-like. A fleet bill and the fleet's quotes share a scale; judging
    one against real market prices would report every settlement this project
    has ever made as a six-figure bp overpay."""
    ours = sorted(FLEET_SELLERS)[0]
    status, j = _get(unit=UNIT, billed_usdc=5.0, quantity=10, vendor=ours)
    assert status == 200
    assert j["benchmarked_against"] == "fleet"
    assert j["vendor_supplied"] is True


def test_the_comparison_set_comes_back_and_says_whose_prices_they_are():
    """A verdict without its comparison set is a claim without a basis, and
    `graph/schema.graphql` already states the disclosure standard: a benchmark
    that counts its own seller silently is claiming security it has not got."""
    _, j = _get(unit=UNIT, billed_usdc=0.02, quantity=10)
    quotes = j["par"]["quotes"]
    assert quotes, "the comparison set is empty"
    assert all("seller" in q and "price_usdc" in q for q in quotes)
    assert all(q["first_party"] is False for q in quotes), (
        "a market basket row was marked as one of ours"
    )
    assert j["par"]["first_party_sellers"] == 0


def test_the_basket_declares_its_date_and_what_it_is_missing():
    """"A basket that shrinks silently re-medians a different population" is
    GAP.md's own sentence, so the rows it HAS and the rows it ASKED FOR both
    travel with the price."""
    _, j = _get(unit=UNIT, billed_usdc=0.02, quantity=10)
    b = j["basket"]
    assert b["fetched_at"] > 0
    assert b["requested"] >= b["rows"] > 0


# --- what it would do -------------------------------------------------------

def test_a_bill_far_over_the_market_is_escalated_and_not_rerouted():
    """The cheaper rows are model ids, not addresses. A reroute the wallet
    cannot execute is worse than an escalation it can."""
    _, j = _get(unit=UNIT, billed_usdc=0.02, quantity=10)
    assert j["would"]["intent"] == "escalate"
    assert j["would"]["recommended_intent"] == "refuse"
    assert "going market rate" in j["would"]["rule"]


def test_a_bill_at_the_going_rate_is_paid_and_reads_as_at_the_rate():
    """`verdict.verdict` says "over_par" here, and that is not a bug in the
    engine: it keys off the CHEAPEST row, which is the right test when the
    cheaper seller is payable. It is the wrong thing to hand a caller, so the
    route states `over_rate_bp` and the ladder's answer agrees with it."""
    _, j = _get(unit=UNIT, billed_usdc=0.004, quantity=10)
    assert abs(j["over_rate_bp"]) < 1, f"not at the going rate: {j['over_rate_bp']}"
    assert j["would"]["intent"] == "pay"


def test_what_it_could_not_check_is_named_rather_than_implied():
    """A caller who has onboarded nothing has no meter, no screen, no agreement,
    no budget and no balance. Each absence leaves a note, because a `pay` with
    no notes reads as a decision that passed every check."""
    _, j = _get(unit=UNIT, billed_usdc=0.004, quantity=10)
    notes = " ".join(j["would"]["notes"])
    assert "cash" in notes, j["would"]["notes"]
    assert j["would"]["rule"], "every outcome carries a rule"


# --- the refusals -----------------------------------------------------------

def test_a_typo_in_the_unit_is_422_and_not_a_shrug():
    """`GET /tca/undefined` once answered 200 "the subgraph did not answer" — a
    caller's typo reported as our outage. An unknown unit must not come back as
    "no market for that"."""
    status, j = _get(unit="$/tokens", billed_usdc=1, quantity=1)
    assert status == 422
    assert "$/1k tokens" in j["detail"], j["detail"]


@pytest.mark.parametrize("billed,qty", [(0, 1), (1, 0), (-1, 1), (1, -1)])
def test_a_non_positive_bill_or_quantity_is_refused(billed, qty):
    status, _ = _get(unit="$/MB", billed_usdc=billed, quantity=qty)
    assert status == 422


def test_a_vendor_that_is_not_an_address_is_refused():
    """`is_first_party` compares addresses. A name would silently be treated as
    a stranger, which is the wrong market for one of our own sellers."""
    status, _ = _get(unit=UNIT, billed_usdc=1, quantity=1, vendor="acme-corp")
    assert status == 422


def test_no_vendor_still_prices_and_says_so():
    _, j = _get(unit=UNIT, billed_usdc=0.02, quantity=10)
    assert j["vendor"] is None and j["vendor_supplied"] is False


# --- the standing rule ------------------------------------------------------

def test_the_indexs_dollar_figure_never_reaches_this_route():
    """The same claim `test_operator_api.py` defends for the statement. This
    route is the one most likely to be mistaken for an index quote, so it is the
    one that must never carry one."""
    _, j = _get(unit=UNIT, billed_usdc=0.02, quantity=10)
    blob = json.dumps(j)
    assert "overpaid_usdc" not in blob
    # And no figure anywhere near the reference level, which is 0.5 $/1k tokens.
    assert j["par"]["par_usdc"] is None or j["par"]["par_usdc"] < 0.01
