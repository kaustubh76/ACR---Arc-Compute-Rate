"""Bittensor rows become ordinary quotes, and a sold-out row stops being advice.

The fixture below is written here rather than copied from
`anchors/_bittensor/BCR-GPU/2026-10-23.json`, which is another session's
uncommitted output. It MIRRORS that file: same `acr.anchor/1` schema, same
`$/GPU-sec` unit, the same `raw` keys, and five of its real rows with their real
prices and their real `listed_gpus`/`rented_gpus`. The numbers asserted here were
first measured against the live file.
"""
from __future__ import annotations

import dataclasses

import pytest
from index_api.bittensor_quotes import SCHEMA, quotes_from_basket
from index_api.par import assess, par_from_quotes

HOUR = 3600.0


def _row(rid, usd_per_hour, listed, rented, cls, vram, arch="ampere"):
    return {
        "id": rid,
        "price_usd_per_unit": usd_per_hour / HOUR,
        "source": {
            "kind": "http",
            "url": "https://lium.io/pricing.json",
            "json_path": "models[].reference_price_usd_per_gpu_hour",
        },
        "raw": {
            "reference_price_usd_per_gpu_hour": usd_per_hour,
            "vram_gb": vram,
            "gpu_class": cls,
            "architecture": arch,
            "listed_gpus": listed,
            "rented_gpus": rented,
        },
    }


#: Real rows, real numbers. Only the A6000 and the B300 have spare capacity,
#: which is the whole finding: 13 of the live basket's 15 rows are fully booked.
BASKET = {
    "schema": SCHEMA,
    "index_id": "BCR-GPU",
    "unit": "$/GPU-sec",
    "fetched_at": "2026-10-23T05:00:00+00:00",
    "rows": [
        _row("RTX 3060", 0.060, 2, 2, "consumer", 12),
        _row("RTX A6000", 0.420, 76, 73, "professional", 48),
        _row("A100 80GB PCIe", 0.450, 14, 14, "datacenter", 80),
        _row("H100 PCIe", 1.300, 3, 3, "datacenter", 80, "hopper"),
        _row("B300 SXM6 AC", 8.000, 233, 206, "datacenter", 288, "blackwell"),
    ],
}


def _quotes():
    return quotes_from_basket(BASKET, resource="gpu-hour")


# --- the read ------------------------------------------------------------------


def test_every_priced_row_becomes_a_catalog_quote():
    qs = _quotes()
    assert len(qs) == 5
    # A LISTING, never a fill. BCR reads listings, not trades, and `fill` would
    # manufacture a tape.
    assert {q.source for q in qs} == {"catalog"}
    assert all(not q.first_party for q in qs), "Bittensor is not our fleet"
    assert all(q.url and q.cite for q in qs), "every price must be checkable"
    assert all(q.at > 0 for q in qs), "a price with no age is the failure to avoid"


def test_availability_is_derived_because_the_source_does_not_publish_it():
    by = {q.seller: q for q in _quotes()}
    # listed - rented, per row.
    assert by["RTX A6000"].available_units == 3.0
    assert by["B300 SXM6 AC"].available_units == 27.0
    assert by["A100 80GB PCIe"].available_units == 0.0
    assert by["RTX 3060"].available_units == 0.0


def test_a_missing_count_is_unknown_and_never_sold_out():
    """`None` and `0` are opposite claims, and conflating them would empty the
    basket the first time the upstream shape changed."""
    thin = {**BASKET, "rows": [{"id": "x", "price_usd_per_unit": 1.0, "raw": {}, "source": {}}]}
    q = quotes_from_basket(thin)[0]
    assert q.available_units is None
    assert q.purchasable is True


def test_published_quality_rides_along():
    by = {q.seller: q for q in _quotes()}
    a100 = by["A100 80GB PCIe"]
    assert a100.quality_of("gpu_class") == "datacenter"
    assert a100.quality_of("vram_gb") == "80"
    assert a100.quality_of("architecture") == "ampere"
    assert a100.quality_of("nonsense", "·") == "·"


def test_an_unknown_schema_is_refused_rather_than_half_parsed():
    with pytest.raises(ValueError, match="unsupported basket schema"):
        quotes_from_basket({**BASKET, "schema": "acr.anchor/2"})


def test_rows_with_no_usable_price_are_dropped_not_zeroed():
    odd = {**BASKET, "rows": [
        {"id": "free", "price_usd_per_unit": 0, "raw": {}, "source": {}},
        {"id": "text", "price_usd_per_unit": "1.0", "raw": {}, "source": {}},
        _row("RTX A6000", 0.420, 76, 73, "professional", 48),
    ]}
    qs = quotes_from_basket(odd)
    assert [q.seller for q in qs] == ["RTX A6000"]


# --- the gate, which is the point ----------------------------------------------


def test_the_named_alternative_must_be_one_somebody_can_buy():
    """Measured against the live 2026-10-23 basket before it was written here.

    Without the gate the cheapest row is an RTX 3060 at $0.060/GPU-hr with zero
    units free, and a $1.99 bill is reported as $1.93 recoverable. With it, the
    alternative is an RTX A6000 at $0.420 with three free, and the claim falls
    to $1.57. The second number is smaller and it is the true one.
    """
    qs = _quotes()
    blind = [dataclasses.replace(q, available_units=None) for q in qs]

    ungated = par_from_quotes("gpu-hour", blind, denomination="unit")
    assert ungated.best_seller == "RTX 3060"
    assert ungated.sold_out_cheaper == 0
    assert assess(1.99, ungated, quantity=HOUR)["saving_usdc"] == pytest.approx(1.93, abs=0.01)

    gated = par_from_quotes("gpu-hour", qs, denomination="unit")
    assert gated.best_seller == "RTX A6000"
    assert gated.best_purchasable is True
    assert gated.sold_out_cheaper == 1  # the 3060, cheaper and sold out
    assert assess(1.99, gated, quantity=HOUR)["saving_usdc"] == pytest.approx(1.57, abs=0.01)


def test_the_median_keeps_every_price_even_the_sold_out_ones():
    """A sold-out listing is still an observation of what this costs. Dropping it
    would bias the benchmark on a fact that has nothing to do with price."""
    gated = par_from_quotes("gpu-hour", _quotes(), denomination="unit")
    assert gated.sellers == 5, "all five rows are in the median"
    assert gated.par_usdc == pytest.approx(0.450 / HOUR)  # A100, the middle row


def test_a_basket_with_nothing_left_claims_no_saving_at_all():
    """Dear, not recoverable — `assess`'s own rule, applied to availability.

    `best_usdc` stays visible because the price is real; what is withdrawn is
    the claim that anybody can act on it.
    """
    sold_out = {**BASKET, "rows": [
        _row("RTX 3060", 0.060, 2, 2, "consumer", 12),
        _row("A100 80GB PCIe", 0.450, 14, 14, "datacenter", 80),
        _row("H100 PCIe", 1.300, 3, 3, "datacenter", 80, "hopper"),
    ]}
    par = par_from_quotes("gpu-hour", quotes_from_basket(sold_out), denomination="unit")
    assert par.best_purchasable is False
    assert par.best_usdc == pytest.approx(0.060 / HOUR), "the price is still shown"
    a = assess(1.99, par, quantity=HOUR)
    assert a["saving_usdc"] == 0.0, "nothing on offer is not a saving"
    assert a["best_purchasable"] is False
    # And so the reroute rung cannot fire: the verdict is not over_par.
    assert a["verdict"] != "over_par"


def test_an_unavailable_quote_still_cannot_outrank_a_cheaper_available_one():
    """Ordering sanity: the gate picks the cheapest PURCHASABLE, not merely a
    purchasable one."""
    qs = _quotes()
    par = par_from_quotes("gpu-hour", qs, denomination="unit")
    cheapest_available = min(
        (q for q in qs if q.purchasable), key=lambda q: q.price_usdc
    )
    assert par.best_seller == cheapest_available.seller
