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


# --- cohort matching: is it even the same kind of thing? ------------------------


def _wants(cls: str, vram: str) -> object:
    """What the buyer is actually renting, as a cohort."""
    from index_api.par import Quote

    return Quote(
        seller="incumbent", price_usdc=1.99 / HOUR, source="catalog",
        quality=(("gpu_class", cls), ("vram_gb", vram)),
    )


def test_a_class_is_not_a_discount():
    from index_api.par import comparable

    dc80 = _wants("datacenter", "80")
    by = {q.seller: q for q in _quotes()}
    assert comparable(by["A100 80GB PCIe"], dc80) is True
    assert comparable(by["H100 PCIe"], dc80) is True          # same class, same VRAM
    assert comparable(by["RTX 3060"], dc80) is False          # consumer
    assert comparable(by["RTX A6000"], dc80) is False         # professional
    assert comparable(by["B300 SXM6 AC"], dc80) is False      # 288GB, far outside ±25%


def test_no_cohort_means_unmatched_rather_than_refused():
    """What this product did everywhere until now, kept working and labelled."""
    from index_api.par import comparable

    assert comparable(_quotes()[0], None) is True
    par = par_from_quotes("gpu-hour", _quotes(), denomination="unit")
    assert par.cohort_matched is False


def test_a_quote_that_publishes_nothing_is_not_excluded():
    """Refusing every quiet row would empty the basket."""
    from index_api.par import comparable

    bare = quotes_from_basket(
        {**BASKET, "rows": [{"id": "x", "price_usd_per_unit": 1.0, "raw": {}, "source": {}}]}
    )[0]
    assert comparable(bare, _wants("datacenter", "80")) is True


def test_the_vram_band_is_plus_or_minus_a_quarter():
    from index_api.par import COHORT_SIZE_TOLERANCE, comparable

    assert COHORT_SIZE_TOLERANCE == 0.25
    rows = [_row("edge", 1.0, 9, 1, "datacenter", v) for v in (60, 64, 96, 100, 101, 59)]
    qs = quotes_from_basket({**BASKET, "rows": rows})
    want = _wants("datacenter", "80")
    got = {q.quality_of("vram_gb"): comparable(q, want) for q in qs}
    assert got == {"60": True, "64": True, "96": True, "100": True, "101": False, "59": False}


def test_the_whole_ladder_on_the_real_worked_example():
    """Three gates, three answers, measured on the 2026-10-23 basket.

    A buyer renting a datacenter 80GB card at $1.99/GPU-hr:

      ungated        -> RTX 3060   $0.060  sold out, consumer    claims $1.93
      availability   -> RTX A6000  $0.420  in stock, WRONG class claims $1.57
      + cohort       -> A100 80GB  $0.450  right class, none left claims $0.00

    The last one is the only defensible answer, and it is the one that says
    there is nothing to recover. BCR reached the same place by hand: every card
    anchoring its 2.6x claim is fully booked.
    """
    qs = _quotes()
    blind = [dataclasses.replace(q, available_units=None) for q in qs]

    ungated = par_from_quotes("gpu-hour", blind, denomination="unit")
    assert (ungated.best_seller, ungated.cohort_matched) == ("RTX 3060", False)

    avail_only = par_from_quotes("gpu-hour", qs, denomination="unit")
    assert avail_only.best_seller == "RTX A6000"
    assert avail_only.sold_out_cheaper == 1

    full = par_from_quotes("gpu-hour", qs, denomination="unit", cohort=_wants("datacenter", "80"))
    assert full.best_seller == "A100 80GB PCIe", "the fallback must name the RIGHT product"
    assert full.best_purchasable is False
    assert full.cohort_matched is True
    assert full.off_cohort_cheaper == 2, "the 3060 and the A6000 are cheaper and a different class"
    assert assess(1.99, full, quantity=HOUR)["saving_usdc"] == 0.0

    # And the median is identical under all three: only the CLAIM is gated.
    assert ungated.par_usdc == avail_only.par_usdc == full.par_usdc


def test_a_comparable_row_in_stock_is_named_over_a_cheaper_one_out_of_stock():
    """The preference order: comparable AND in stock beats comparable alone."""
    rows = [
        _row("A100 cheap sold out", 0.300, 10, 10, "datacenter", 80),
        _row("A100 dearer in stock", 0.500, 10, 2, "datacenter", 80),
        _row("RTX 3060", 0.060, 2, 2, "consumer", 12),
    ]
    par = par_from_quotes(
        "gpu-hour", quotes_from_basket({**BASKET, "rows": rows}),
        denomination="unit", cohort=_wants("datacenter", "80"),
    )
    assert par.best_seller == "A100 dearer in stock"
    assert par.best_purchasable is True
    assert par.sold_out_cheaper == 1
    assert par.off_cohort_cheaper == 1
