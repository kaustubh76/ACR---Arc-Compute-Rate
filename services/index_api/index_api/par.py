"""Observed-quote PAR — what a service actually costs, from somebody selling it.

THIS MODULE EXISTS BECAUSE THE INDEX CANNOT PRICE A REAL INVOICE.

``anchors/GAP.md`` records this project's index reference levels sitting 20x to
1159x away from real market prices, and says plainly that they are not being
changed: they seed the simulator, the fleet's quotes and the tape's price pin,
so moving them would break comparability with every print already on chain.

Inside ACR's own priced world that is harmless. Buyer and seller are both pinned
to the same scale, so ``graph/src/tca.ts``'s ``slippageBp(paid, arrival)`` is a
real measurement and every bp-denominated figure is exactly scale-invariant.

It stops being harmless the moment a real business's real invoice arrives. A
vendor billing $0.0005 per 1k tokens against a 0.5 $/1k-token reference level
measures as roughly -9,990 bp — not a bargain, an incomparable unit. Any "overpay
caught, in USDC" number built that way is indefensible, and GAP.md is in the
public repo for a reviewer to open.

So the operator's benchmark is built from prices it watched somebody offer or
accept for the SAME service:

    par       the median of independent observed prices — the standard measure,
              "what the market is actually paying" in RFB 3's words.
    best      the cheapest independent offer — the actionable one.

and the two answer different questions, so both are reported and the stronger
claim is kept for the stronger evidence:

    "above the going rate"      par, a soft statement about one price in a market
    "could have paid X at Y"    best, and only when that seller is reachable

The second is the only one allowed to become a USDC savings figure, because it is
the only one where the money was really available. ``tca.py``'s ``_reroute``
already carries the same caveat in the same voice: *a suggestion, not a promise.*

COMPARABILITY. Prices here are per CALL and are only ever compared WITHIN one
resource, where the quantity per call is fixed by the endpoint. Comparing a
per-call price across resources without normalising by quantity is the unit bug
this file is about; ``unit``/``quantity`` ride along so a caller that needs to
cross resources can do it deliberately rather than by accident.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from acr_core.mathutils import weighted_median

log = logging.getLogger("index_api.par")

#: One offer is not a market. Below this many INDEPENDENT sellers the answer is
#: "unbenchmarked" with a reason, never a comparison of a price to itself.
#: ``apps/agent/src/reroute.ts`` holds for the same reason at the same number.
MIN_SELLERS = 2

#: A price must clear the billed price by this much before the operator calls it
#: an overpay worth acting on. Matches ``reroute.ts``'s 25 bp default, so the
#: price decision and the routing decision agree about what "material" means.
MATERIAL_BP = 25.0


@dataclass(frozen=True)
class Quote:
    """One price, observed — not modelled."""

    seller: str
    price_usdc: float
    #: ``catalog`` a published listing · ``challenge`` a live 402 we did not pay
    #: · ``fill`` a settlement that actually happened.
    source: str
    resource: str = ""
    at: float = 0.0
    #: The index unit the quantity is in, when the listing declares it.
    unit: str = ""
    quantity: float = 0.0

    @property
    def unit_price(self) -> float | None:
        """Per unit of service, or None — never 0.

        ``PaymentReceipt.unit_price`` makes the same choice: a missing quantity
        must not render as a free service.
        """
        if self.quantity <= 0:
            return None
        return self.price_usdc / self.quantity


@dataclass(frozen=True)
class Par:
    """The benchmark for one resource, and what it is allowed to claim."""

    resource: str
    available: bool
    #: Why not, when unavailable. Mirrors the subgraph's
    #: ``unbenchmarkedReason``: an absent benchmark says which absence it is.
    reason: str = ""
    par_usdc: float | None = None
    best_usdc: float | None = None
    best_seller: str = ""
    sellers: int = 0
    basis: str = ""
    quotes: tuple[Quote, ...] = field(default_factory=tuple)

    def as_dict(self) -> dict:
        return {
            "resource": self.resource,
            "available": self.available,
            "reason": self.reason,
            "par_usdc": self.par_usdc,
            "best_usdc": self.best_usdc,
            "best_seller": self.best_seller,
            "sellers": self.sellers,
            "basis": self.basis,
            "quotes": [
                {"seller": q.seller, "price_usdc": q.price_usdc, "source": q.source}
                for q in self.quotes
            ],
        }


def _dedupe_by_seller(quotes: list[Quote]) -> list[Quote]:
    """One price per seller: their cheapest.

    A seller listing the same resource twice would otherwise count twice in the
    median, which is how one party moves a benchmark without underselling
    anybody. The tape's sybil cleaning stage exists for the same reason; this is
    the cheap version of it, and it is the only one available on a live quote.
    """
    best: dict[str, Quote] = {}
    for q in quotes:
        key = (q.seller or "").lower()
        if not key:
            continue
        held = best.get(key)
        if held is None or q.price_usdc < held.price_usdc:
            best[key] = q
    return sorted(best.values(), key=lambda q: q.price_usdc)


def par_from_quotes(
    resource: str,
    quotes: list[Quote],
    exclude_seller: str = "",
    min_sellers: int = MIN_SELLERS,
) -> Par:
    """The benchmark, or a stated reason there isn't one.

    ``exclude_seller`` drops the party whose bill is being checked. They are not
    an alternative to themselves, and leaving them in both moves the median
    toward the price under examination and lets "reroute to the cheapest seller"
    name the incumbent.
    """
    priced = [q for q in quotes if q.price_usdc > 0]
    if not priced:
        return Par(resource=resource, available=False, reason="NO_QUOTES")

    if exclude_seller:
        skip = exclude_seller.lower()
        priced = [q for q in priced if (q.seller or "").lower() != skip]
        if not priced:
            return Par(
                resource=resource, available=False, reason="NO_INDEPENDENT_SELLER"
            )

    uniq = _dedupe_by_seller(priced)
    if len(uniq) < min_sellers:
        return Par(
            resource=resource,
            available=False,
            reason="ONE_SELLER" if len(uniq) == 1 else "NO_QUOTES",
            sellers=len(uniq),
            quotes=tuple(uniq),
        )

    prices = [q.price_usdc for q in uniq]
    # Unit weights: a quote is an offer, not a fill, and carries no volume to
    # weight by. Still the house median, so one median serves the whole product.
    #
    # NOTE, because it is a real property and not an accident: `weighted_median`
    # is the 50% weighted QUANTILE, so on an even sample it returns the LOWER of
    # the two middle prices ([1.00, 1.20] -> 1.00, not 1.10). That biases `par`
    # down, and therefore `over_par` up — the direction that would overstate how
    # dear a bill is. It is why `assess`'s verdict keys off `saving_bp`, measured
    # against `best`, and never off `over_par_bp`: the number that can become a
    # claim does not inherit the bias. Interpolating here instead would give this
    # module its own median while `_p50_bp` keeps the tape's, and two medians in
    # one product is worse than one documented quirk.
    par = float(weighted_median(prices, [1.0] * len(prices)))
    cheapest = uniq[0]

    sources = sorted({q.source for q in uniq})
    return Par(
        resource=resource,
        available=True,
        par_usdc=par,
        best_usdc=cheapest.price_usdc,
        best_seller=cheapest.seller,
        sellers=len(uniq),
        basis=" + ".join(sources),
        quotes=tuple(uniq),
    )


def assess(billed_usdc: float, par: Par, material_bp: float = MATERIAL_BP) -> dict:
    """What the billed price looks like against the benchmark.

    ``saving_usdc`` is measured against ``best``, never against ``par``: it is
    the money that was actually available somewhere else. A price above the
    median with nothing cheaper on offer is dear, not recoverable, and calling
    that a saving would be inventing one.
    """
    if not par.available:
        return {
            "benchmarked": False,
            "reason": par.reason,
            "billed_usdc": billed_usdc,
            "verdict": "unbenchmarked",
        }

    assert par.par_usdc is not None and par.best_usdc is not None
    over_par_usdc = billed_usdc - par.par_usdc
    over_par_bp = (over_par_usdc / par.par_usdc) * 10_000 if par.par_usdc > 0 else None
    saving_usdc = max(billed_usdc - par.best_usdc, 0.0)
    saving_bp = (
        (saving_usdc / billed_usdc) * 10_000 if billed_usdc > 0 else 0.0
    )

    if over_par_bp is None:
        verdict = "unbenchmarked"
    elif saving_bp >= material_bp:
        verdict = "over_par"
    elif over_par_bp <= -material_bp:
        verdict = "under_par"
    else:
        verdict = "at_par"

    return {
        "benchmarked": True,
        "reason": "",
        "billed_usdc": billed_usdc,
        "par_usdc": par.par_usdc,
        "best_usdc": par.best_usdc,
        "best_seller": par.best_seller,
        "over_par_usdc": over_par_usdc,
        "over_par_bp": over_par_bp,
        # Recoverable, because somebody is offering it at that price.
        "saving_usdc": saving_usdc,
        "saving_bp": saving_bp,
        "sellers": par.sellers,
        "basis": par.basis,
        "verdict": verdict,
        "note": "a suggestion, not a promise",
    }


# --- reading prices out of what the rails already say ----------------------


def price_from_accepts(accepts: list[dict]) -> float | None:
    """The cheapest price among a listing's payment options, in USDC.

    Both x402 vintages are read: ``amount`` (v2) and ``maxAmountRequired`` (v1)
    carry the same atomic value, and ``build_payment_requirements`` emits both.
    All options are considered rather than ``accepts[0]`` alone — a seller
    offering two schemes at different prices is quoting the cheaper one, and
    taking the first would make the benchmark depend on list order.
    """
    prices: list[float] = []
    for a in accepts or []:
        atomic = a.get("amount") or a.get("maxAmountRequired")
        if isinstance(atomic, str) and atomic.isdigit():
            prices.append(int(atomic) / 1e6)
        elif isinstance(atomic, int) and not isinstance(atomic, bool):
            prices.append(atomic / 1e6)
    return min(prices) if prices else None


def quotes_from_catalog(catalog: dict, resource: str) -> list[Quote]:
    """Every published price for one resource, from a Bazaar-shaped catalog.

    Pure: the catalog is already fetched. The seller is ``payTo`` — the wallet
    that gets paid — because that is the party a reroute would actually send
    money to. ``acr-venue-three-wallets`` is the standing reminder that the
    payee, the owner and the operator are three different addresses.
    """
    out: list[Quote] = []
    now = time.time()
    for item in catalog.get("items") or []:
        if item.get("resource") != resource:
            continue
        accepts = item.get("accepts") or []
        price = price_from_accepts(accepts)
        if price is None:
            continue
        pay_to = ""
        for a in accepts:
            if a.get("payTo"):
                pay_to = str(a["payTo"])
                break
        meta = item.get("metadata") or {}
        out.append(
            Quote(
                seller=pay_to,
                price_usdc=price,
                source="catalog",
                resource=resource,
                at=now,
                unit=str(meta.get("unit") or ""),
                quantity=float(meta.get("quantity") or 0.0),
            )
        )
    return out


def quotes_from_receipts(receipts: list[dict], resource: str) -> list[Quote]:
    """Prices that were actually paid for one resource.

    A fill is stronger evidence than an offer: somebody accepted it. Shaped for
    the rows ``marketplace.build_receipts`` emits, so the operator reads the same
    ledger the tape publishes.
    """
    out: list[Quote] = []
    for r in receipts or []:
        if r.get("resource") != resource:
            continue
        amount = r.get("amount_usdc")
        if not isinstance(amount, (int, float)) or amount <= 0:
            continue
        out.append(
            Quote(
                seller=str(r.get("seller") or ""),
                price_usdc=float(amount),
                source="fill",
                resource=resource,
                at=float(r.get("settled_at") or 0.0),
                unit=str(r.get("unit") or ""),
                quantity=float(r.get("quantity") or 0.0),
            )
        )
    return out
