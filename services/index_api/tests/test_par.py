"""Observed-quote PAR — the arithmetic, and the claims it refuses to make.

The headline test is ``test_a_market_priced_invoice_is_not_measured_against_the
_index``: it demonstrates, in numbers, the mistake this module exists to prevent.
Everything else guards a refusal — one offer is not a market, the incumbent is
not an alternative to itself, and a price nobody will beat is dear rather than
recoverable.
"""

from __future__ import annotations

import pytest
from index_api.par import (
    MATERIAL_BP,
    Par,
    Quote,
    assess,
    par_from_quotes,
    price_from_accepts,
    quotes_from_catalog,
    quotes_from_receipts,
)

RES = "https://acr.example/compute/inference"
A = "0x" + "aa" * 20
B = "0x" + "bb" * 20
C = "0x" + "cc" * 20


def _q(seller: str, price: float, source: str = "catalog", **kw) -> Quote:
    return Quote(seller=seller, price_usdc=price, source=source, resource=RES, **kw)


# --- the mistake this module prevents --------------------------------------

def test_a_market_priced_invoice_is_not_measured_against_the_index():
    """anchors/GAP.md puts ACR-INF's reference level at 0.5 $/1k tokens while the
    market sits near 0.00043. Measuring a real invoice against the index reads as
    a ~9,990 bp discount on a bill that is in fact slightly over the going rate.
    Against observed quotes for the same service the answer is small and right."""
    index_reference = 0.5          # what the index prints
    billed = 0.00050              # what a real vendor charged
    market = [0.00043, 0.00045, 0.00047]  # what others charge

    naive_bp = ((billed - index_reference) / index_reference) * 10_000
    assert naive_bp < -9_000, "this is the nonsense number we must never publish"

    par = par_from_quotes(RES, [_q(A, market[0]), _q(B, market[1]), _q(C, market[2])])
    out = assess(billed, par)

    assert out["benchmarked"] is True
    assert out["par_usdc"] == pytest.approx(0.00045)
    assert 0 < out["over_par_bp"] < 2_000, "a real, small, defensible number"
    assert out["verdict"] == "over_par"
    assert out["saving_usdc"] == pytest.approx(0.00007)


# --- one offer is not a market ---------------------------------------------

def test_no_quotes_is_a_stated_reason_not_a_price():
    p = par_from_quotes(RES, [])
    assert p.available is False and p.reason == "NO_QUOTES"
    assert p.par_usdc is None, "an absent benchmark must not render as free"


def test_a_single_seller_is_refused_rather_than_compared_to_itself():
    p = par_from_quotes(RES, [_q(A, 1.0)])
    assert p.available is False and p.reason == "ONE_SELLER"
    assert p.sellers == 1


def test_the_incumbent_is_not_an_alternative_to_itself():
    """Excluding the biller both keeps the median off the price under
    examination and stops 'reroute to the cheapest' naming the incumbent."""
    p = par_from_quotes(RES, [_q(A, 1.0)], exclude_seller=A)
    assert p.available is False and p.reason == "NO_INDEPENDENT_SELLER"

    p2 = par_from_quotes(RES, [_q(A, 0.10), _q(B, 1.00), _q(C, 1.20)], exclude_seller=A)
    assert p2.available is True
    assert p2.best_seller == B, "the cheap incumbent is gone from the alternatives"
    assert p2.par_usdc == pytest.approx(1.00), "lower median of [1.00, 1.20]"


def test_a_seller_listing_twice_counts_once_at_their_cheapest():
    """Otherwise one party moves the benchmark without underselling anybody."""
    p = par_from_quotes(RES, [_q(A, 5.0), _q(A, 9.0), _q(A, 7.0), _q(B, 1.0)])
    assert p.sellers == 2
    assert p.best_usdc == pytest.approx(1.0)
    assert sorted(q.price_usdc for q in p.quotes) == [1.0, 5.0]


def test_the_seller_match_ignores_address_case():
    p = par_from_quotes(RES, [_q(A.upper(), 2.0), _q(A.lower(), 3.0), _q(B, 1.0)])
    assert p.sellers == 2, "0xAA… and 0xaa… are one seller"


def test_a_zero_or_negative_price_is_not_a_quote():
    p = par_from_quotes(RES, [_q(A, 0.0), _q(B, -1.0), _q(C, 2.0)])
    assert p.available is False and p.sellers == 1


# --- what a saving is allowed to mean --------------------------------------

def test_a_saving_is_measured_against_the_best_offer_not_the_median():
    p = par_from_quotes(RES, [_q(A, 1.00), _q(B, 2.00), _q(C, 3.00)])
    out = assess(5.00, p)
    assert out["par_usdc"] == pytest.approx(2.00)
    assert out["over_par_usdc"] == pytest.approx(3.00), "vs the going rate"
    assert out["saving_usdc"] == pytest.approx(4.00), "vs what was actually available"


def test_a_dear_price_nobody_will_beat_yields_no_saving():
    """Above the median with nothing cheaper on offer is dear, not recoverable.
    Calling that a saving would be inventing one."""
    p = par_from_quotes(RES, [_q(A, 10.0), _q(B, 12.0), _q(C, 14.0)])
    out = assess(12.0, p)
    assert out["par_usdc"] == pytest.approx(12.0)
    assert out["over_par_usdc"] == pytest.approx(0.0), "exactly the going rate"
    assert out["saving_usdc"] == pytest.approx(2.0), "and 10.0 was on offer"

    # The cheapest price in the market is dear in absolute terms and still
    # recovers nothing, because nobody is beating it.
    out_best = assess(10.0, p)
    assert out_best["saving_usdc"] == pytest.approx(0.0)
    assert out_best["verdict"] == "under_par"


def test_a_price_inside_the_material_band_is_at_par():
    p = par_from_quotes(RES, [_q(A, 1.0), _q(B, 1.0), _q(C, 1.0)])
    out = assess(1.0 * (1 + (MATERIAL_BP / 2) / 10_000), p)
    assert out["verdict"] == "at_par"


def test_a_cheap_price_reads_as_under_par():
    p = par_from_quotes(RES, [_q(A, 1.0), _q(B, 1.0), _q(C, 1.0)])
    out = assess(0.5, p)
    assert out["verdict"] == "under_par"
    assert out["saving_usdc"] == pytest.approx(0.0), "nothing to recover"


def test_an_unbenchmarked_assessment_passes_the_reason_through():
    out = assess(1.0, Par(resource=RES, available=False, reason="ONE_SELLER"))
    assert out["benchmarked"] is False
    assert out["reason"] == "ONE_SELLER"
    assert out["verdict"] == "unbenchmarked"
    assert "saving_usdc" not in out, "no number may be read off an absent benchmark"


# --- reading prices out of the rails ---------------------------------------

def test_both_x402_vintages_are_read():
    assert price_from_accepts([{"amount": "1000"}]) == pytest.approx(0.001)
    assert price_from_accepts([{"maxAmountRequired": "2500"}]) == pytest.approx(0.0025)
    assert price_from_accepts([{"amount": 1000}]) == pytest.approx(0.001)


def test_the_cheapest_option_is_quoted_not_the_first():
    """A seller offering two schemes at two prices is quoting the cheaper one;
    taking accepts[0] would make the benchmark depend on list order."""
    accepts = [{"amount": "9000"}, {"amount": "1000"}]
    assert price_from_accepts(accepts) == pytest.approx(0.001)
    assert price_from_accepts(list(reversed(accepts))) == pytest.approx(0.001)


def test_an_unpriced_listing_is_none_rather_than_zero():
    assert price_from_accepts([]) is None
    assert price_from_accepts([{"scheme": "exact"}]) is None
    assert price_from_accepts([{"amount": "not-a-number"}]) is None


def test_the_catalog_yields_one_quote_per_listing_keyed_on_who_gets_paid():
    catalog = {
        "items": [
            {"resource": RES, "accepts": [{"amount": "1000", "payTo": A}]},
            {"resource": RES, "accepts": [{"amount": "2000", "payTo": B}]},
            {"resource": "other", "accepts": [{"amount": "5", "payTo": C}]},
            {"resource": RES, "accepts": [{"payTo": C}]},  # unpriced
        ]
    }
    qs = quotes_from_catalog(catalog, RES)
    assert {q.seller for q in qs} == {A, B}
    assert all(q.source == "catalog" for q in qs)


def test_fills_are_read_from_the_same_ledger_the_tape_publishes():
    receipts = [
        {"resource": RES, "amount_usdc": 0.5, "seller": A, "settled_at": 1.0},
        {"resource": RES, "amount_usdc": 0.0, "seller": B},          # unpriced
        {"resource": "other", "amount_usdc": 9.0, "seller": C},      # wrong resource
        {"resource": RES, "amount_usdc": 0.7, "seller": B, "quantity": 2.0, "unit": "tok"},
    ]
    qs = quotes_from_receipts(receipts, RES)
    assert [q.seller for q in qs] == [A, B]
    assert all(q.source == "fill" for q in qs)


def test_a_basis_names_every_kind_of_evidence_behind_it():
    p = par_from_quotes(RES, [_q(A, 1.0, "catalog"), _q(B, 2.0, "fill")])
    assert p.basis == "catalog + fill"


# --- units -----------------------------------------------------------------

def test_a_missing_quantity_makes_the_unit_price_none_never_zero():
    """PaymentReceipt.unit_price makes the same choice: a service with no
    recorded quantity must not render as free."""
    assert _q(A, 1.0).unit_price is None
    assert _q(A, 1.0, quantity=0.0).unit_price is None
    assert _q(A, 1.0, quantity=2.0).unit_price == pytest.approx(0.5)


def test_the_even_sample_median_is_the_lower_of_the_two_middle_prices():
    """Pinned because it is chosen, not accidental: the house weighted_median is
    a 50% quantile. It biases par down and over_par up, which is why the verdict
    keys off saving (vs best) rather than off over_par."""
    p = par_from_quotes(RES, [_q(A, 1.00), _q(B, 1.20)])
    assert p.par_usdc == pytest.approx(1.00)

    # The bias cannot reach the number that becomes a claim.
    out = assess(1.00, p)
    assert out["over_par_usdc"] == pytest.approx(0.0)
    assert out["saving_usdc"] == pytest.approx(0.0)
    assert out["verdict"] == "at_par", "not over_par, despite the downward median"
