"""Observed-quote PAR — what a service actually costs, from somebody selling it.

THIS MODULE EXISTS BECAUSE THE INDEX CANNOT PRICE A REAL INVOICE.

``anchors/GAP.md`` records this project's index reference levels sitting 20x to
1250x away from real market prices, and says plainly that they are not being
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

import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from acr_core.mathutils import weighted_median

from .fleet import FLEET

log = logging.getLogger("index_api.par")

#: The market baskets `scripts/anchors.py --fetch` writes. Same idiom as
#: `acr_estimator.human_caps._BASKET`, and the Dockerfile copies `anchors/` into
#: the image (line 23) for exactly this kind of read — the C-HUMAN bound once
#: reported 0 in production because an earlier image did not.
_ANCHOR_DIR = Path(__file__).resolve().parents[3] / "anchors"

#: How stale a basket may be before it stops being a price. `anchors.py` calls
#: `--fetch` "network; manual, never CI", so nothing refreshes these on a timer
#: and a quarter-old basket pricing a live invoice would be a number pretending
#: to be an observation. A list price does not move daily, so thirty days is
#: generous rather than tight — the point is that the staleness has a name.
ANCHOR_MAX_AGE_S = float(os.environ.get("ACR_ANCHOR_MAX_AGE_S", str(30 * 86_400)))

#: Every seller this deployment operates, by address. `Quote.first_party` is
#: resolved against it, and `graph/schema.graphql` already states the standard
#: this exists to meet: "a benchmark that counted one silently would be claiming
#: security it does not have. A reader discounts it from the tape itself,
#: without having to trust the operator."
FLEET_SELLERS = frozenset(
    (listing.seller or "").lower() for listing in FLEET.values() if listing.seller
)

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
    #: Is this seller one of OURS? `graph/schema.graphql` states the standard
    #: this meets: "a benchmark that counted one silently would be claiming
    #: security it does not have. A reader discounts it from the tape itself,
    #: without having to trust the operator." The tape has carried that
    #: disclosure since the beginning; the operator's benchmark did not, and
    #: measured against the live decision archive it mattered — 6 of the 7
    #: vendors this operator has ever billed are in `fleet.FLEET`.
    #:
    #: Nothing is EXCLUDED on the strength of it. The schema's rule is
    #: disclosure, not removal, and filtering would leave most bills with no
    #: benchmark at all — a worse answer than a disclosed one.
    first_party: bool = False

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
    """The benchmark for one resource, and what it is allowed to claim.

    ``denomination`` is on the object rather than left to the caller because the
    two kinds of price are not interchangeable and mixing them is silent. A
    per-call benchmark compares a whole bill; a per-unit one compares $/1k-tokens
    and has to be multiplied back by the quantity before it is money. ``assess``
    reads this field, so a caller cannot hand a per-call price to a per-unit
    benchmark and get a number that merely looks wrong by a factor of a thousand.
    """

    resource: str
    available: bool
    #: ``call`` a whole request's price · ``unit`` the price of one unit of the
    #: service, which is the only basis on which different sellers of the same
    #: kind of service are comparable at all.
    denomination: str = "call"
    #: Why not, when unavailable. Mirrors the subgraph's
    #: ``unbenchmarkedReason``: an absent benchmark says which absence it is.
    reason: str = ""
    par_usdc: float | None = None
    best_usdc: float | None = None
    best_seller: str = ""
    #: WHERE the cheapest price came from — `catalog` · `challenge` · `fill` ·
    #: `market`. The caller needs it because only some of those name somebody
    #: the wallet can pay: a market row names a model (`openai/gpt-4o-mini`),
    #: which is exactly what makes it checkable and exactly what makes it
    #: unroutable. Carried as the source rather than inferred from the string's
    #: shape, because `_payable_to` answers "is there a counterparty" and this
    #: is the narrower "can USDC reach it".
    best_source: str = ""
    sellers: int = 0
    #: How many of those sellers are OURS. A count beside a count, never a
    #: share: a ratio over a denominator of four is a number pretending to be a
    #: measurement, and `/traction` already refuses rates for the same reason.
    #:
    #: It is the difference between "at par against 4 observed sellers" and "at
    #: par against 4 observed sellers, all four on our own fleet" — and on this
    #: deployment today it is the second.
    first_party_sellers: int = 0
    basis: str = ""
    quotes: tuple[Quote, ...] = field(default_factory=tuple)

    def as_dict(self) -> dict:
        return {
            "resource": self.resource,
            "available": self.available,
            "denomination": self.denomination,
            "reason": self.reason,
            "par_usdc": self.par_usdc,
            "best_usdc": self.best_usdc,
            "best_seller": self.best_seller,
            "best_source": self.best_source,
            "sellers": self.sellers,
            "first_party_sellers": self.first_party_sellers,
            "basis": self.basis,
            "quotes": [
                {
                    "seller": q.seller,
                    "price_usdc": q.price_usdc,
                    "source": q.source,
                    "first_party": q.first_party,
                }
                for q in self.quotes
            ],
        }


@dataclass(frozen=True)
class Basket:
    """A dated set of real third-party prices for one unit, and its provenance.

    `par.py` opens by saying the index cannot price a real invoice. This is the
    other half of that sentence: the prices that CAN. `scripts/anchors.py
    --fetch` already pulls them — real list prices, each row carrying its own
    source URL and retrieval time — and until now they were used only to
    generate `anchors/GAP.md`.

    The provenance travels with the prices rather than beside them, because
    every refusal in this module is a named one and "the basket was stale" and
    "there is no basket" are different facts an owner would act on differently.
    """

    unit: str
    index_id: str = ""
    quotes: tuple[Quote, ...] = ()
    #: Unix seconds the basket was fetched; 0.0 when there is none.
    fetched_at: float = 0.0
    #: What the basket HAS and what it ASKED FOR. Two counts, because
    #: `GAP.md` says it in those words: "a basket that shrinks silently
    #: re-medians a different population." Today ACR-INF holds 5 of 10.
    rows: int = 0
    requested: int = 0
    #: "" when usable, else `ABSENT` · `STALE` · `NO_ROWS` — named the way
    #: `Par.reason` is, so a surface can say which absence it is.
    status: str = "ABSENT"

    @property
    def usable(self) -> bool:
        return bool(self.quotes) and not self.status


def market_basket(
    unit: str,
    now: float | None = None,
    anchor_dir: Path | None = None,
) -> Basket:
    """Real third-party prices for one unit, from `anchors/`.

    Keyed on the UNIT and matched against each basket's own `unit` field rather
    than through an index-id lookup. The unit is already what decides which
    market was consulted everywhere else in this module, and a second mapping
    from unit to index would be a second thing to keep in step.

    Returns a `Basket` rather than a bare list, unlike its `quotes_from_*`
    siblings, because those are pure readers over data handed to them and this
    one does I/O against a dated file. What it found, how old it is and how much
    of it is missing are part of the answer.
    """
    t = time.time() if now is None else now
    root = anchor_dir or _ANCHOR_DIR
    want = (unit or "").strip()
    if not want or not root.exists():
        return Basket(unit=want)

    for child in sorted(root.iterdir()):
        # `_basket/` holds the SELECTION RULES, not measurements; the dated
        # per-index files beside it are the observations.
        if not child.is_dir() or child.name.startswith("_"):
            continue
        files = sorted(child.glob("*.json"))
        if not files:
            continue
        try:
            doc = json.loads(files[-1].read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001 — an unreadable basket is not a crash
            log.warning("par: anchor basket %s unreadable (%s)", files[-1].name, exc)
            continue
        if (doc.get("unit") or "").strip() != want:
            continue

        index_id = str(doc.get("index_id") or child.name)
        rows = [r for r in (doc.get("rows") or []) if isinstance(r, dict)]
        requested = len(rows) + len(doc.get("missing") or [])
        try:
            fetched = datetime.fromisoformat(str(doc.get("fetched_at"))).timestamp()
        except ValueError:
            fetched = 0.0

        # STALE IS NOT ABSENT, and neither is a silent price. `--fetch` is
        # manual by design, so an old basket is the expected failure here.
        if fetched and t - fetched > ANCHOR_MAX_AGE_S:
            return Basket(unit=want, index_id=index_id, fetched_at=fetched,
                          rows=len(rows), requested=requested, status="STALE")

        quotes = tuple(
            Quote(
                # The model id, not an address: these sellers are not on a
                # chain, and `openai/gpt-4o-mini` is what a reader can check.
                seller=str(r.get("id") or r.get("label") or ""),
                price_usdc=float(r["price_usd_per_unit"]),
                source="market",
                unit=want,
                at=fetched,
                first_party=False,
            )
            for r in rows
            if isinstance(r.get("price_usd_per_unit"), (int, float))
            and float(r["price_usd_per_unit"]) > 0
        )
        return Basket(
            unit=want, index_id=index_id, quotes=quotes, fetched_at=fetched,
            rows=len(rows), requested=requested,
            status="" if quotes else "NO_ROWS",
        )
    return Basket(unit=want)


def is_first_party(seller: str | None) -> bool:
    """Is this seller one this deployment operates?

    Address comparison, lowercased, against `fleet.FLEET`. A market-basket
    quote names a model (`openai/gpt-4o-mini`) rather than an address and can
    never match, which is correct: it is not ours.
    """
    return (seller or "").strip().lower() in FLEET_SELLERS


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
    denomination: str = "call",
) -> Par:
    """The benchmark, or a stated reason there isn't one.

    ``exclude_seller`` drops the party whose bill is being checked. They are not
    an alternative to themselves, and leaving them in both moves the median
    toward the price under examination and lets "reroute to the cheapest seller"
    name the incumbent.
    """
    priced = [q for q in quotes if q.price_usdc > 0]
    if not priced:
        return Par(resource=resource, available=False, reason="NO_QUOTES",
                   denomination=denomination)

    if exclude_seller:
        skip = exclude_seller.lower()
        priced = [q for q in priced if (q.seller or "").lower() != skip]
        if not priced:
            return Par(
                resource=resource, available=False, reason="NO_INDEPENDENT_SELLER",
                denomination=denomination,
            )

    uniq = _dedupe_by_seller(priced)
    if len(uniq) < min_sellers:
        return Par(
            resource=resource,
            available=False,
            reason="ONE_SELLER" if len(uniq) == 1 else "NO_QUOTES",
            sellers=len(uniq),
            first_party_sellers=sum(1 for q in uniq if q.first_party),
            quotes=tuple(uniq),
            denomination=denomination,
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
        denomination=denomination,
        par_usdc=par,
        best_usdc=cheapest.price_usdc,
        best_seller=cheapest.seller,
        best_source=cheapest.source,
        sellers=len(uniq),
        first_party_sellers=sum(1 for q in uniq if q.first_party),
        basis=" + ".join(sources),
        quotes=tuple(uniq),
    )


def assess(
    billed_usdc: float,
    par: Par,
    material_bp: float = MATERIAL_BP,
    quantity: float | None = None,
) -> dict:
    """What the billed price looks like against the benchmark.

    ``saving_usdc`` is measured against ``best``, never against ``par``: it is
    the money that was actually available somewhere else. A price above the
    median with nothing cheaper on offer is dear, not recoverable, and calling
    that a saving would be inventing one.

    A PER-UNIT benchmark needs ``quantity``. ``billed_usdc`` is a whole bill and
    the benchmark is the price of one unit, so the comparison happens in unit
    terms and the saving is multiplied back out. Without a quantity there is no
    way to do either, so the answer is "unbenchmarked" with a reason rather than
    a figure that is wrong by however many units the bill covered.
    """
    if not par.available:
        return {
            "benchmarked": False,
            "reason": par.reason,
            "billed_usdc": billed_usdc,
            "verdict": "unbenchmarked",
        }

    per_unit = par.denomination == "unit"
    if per_unit and not (quantity and quantity > 0):
        return {
            "benchmarked": False,
            "reason": "NO_QUANTITY",
            "billed_usdc": billed_usdc,
            "verdict": "unbenchmarked",
        }
    # Everything below compares like with like: a unit price against a unit
    # benchmark, or a whole bill against a whole-bill benchmark.
    scale = float(quantity) if per_unit else 1.0
    comparable = billed_usdc / scale

    assert par.par_usdc is not None and par.best_usdc is not None
    over_par_usdc = (comparable - par.par_usdc) * scale
    over_par_bp = (
        ((comparable - par.par_usdc) / par.par_usdc) * 10_000 if par.par_usdc > 0 else None
    )
    saving_usdc = max(comparable - par.best_usdc, 0.0) * scale
    saving_bp = (saving_usdc / billed_usdc) * 10_000 if billed_usdc > 0 else 0.0

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
        "denomination": par.denomination,
        "par_usdc": par.par_usdc,
        "best_usdc": par.best_usdc,
        "best_seller": par.best_seller,
        "best_source": par.best_source,
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
                first_party=is_first_party(pay_to),
                price_usdc=price,
                source="catalog",
                resource=resource,
                at=now,
                unit=str(meta.get("unit") or ""),
                quantity=float(meta.get("quantity") or 0.0),
            )
        )
    return out


def quotes_by_unit(receipts: list[dict], unit: str) -> list[Quote]:
    """Every seller's UNIT price for one kind of service, from real fills.

    THE UNIT IS THE MARKET, and measuring this repo's own tape proved it: the
    seller fleet gives each seller its own resource path, so no resource has more
    than ONE seller and a resource-keyed benchmark can never fire. Group by unit
    instead and `$/1k tokens` has four sellers spanning 1.3x — a real market with
    real dispersion. GPU-seconds and megabytes have one seller each, which comes
    back as ONE_SELLER, which is the honest answer rather than a missing one.

    The price is `amount / quantity`, so a 500-token call and a 2,000-token call
    from different sellers are finally comparable. A row without a positive
    quantity is skipped rather than divided by zero: `Quote.unit_price` makes the
    same refusal for the same reason.
    """
    out: list[Quote] = []
    want = (unit or "").strip()
    if not want:
        return out
    for r in receipts or []:
        if (r.get("unit") or "").strip() != want:
            continue
        amount, qty = r.get("amount_usdc"), r.get("quantity")
        if not isinstance(amount, (int, float)) or not isinstance(qty, (int, float)):
            continue
        if amount <= 0 or qty <= 0:
            continue
        out.append(
            Quote(
                seller=str(r.get("seller") or ""),
                first_party=is_first_party(str(r.get("seller") or "")),
                price_usdc=float(amount) / float(qty),
                source="fill",
                resource=str(r.get("resource") or ""),
                at=float(r.get("settled_at") or 0.0),
                unit=want,
                quantity=float(qty),
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
                first_party=is_first_party(str(r.get("seller") or "")),
                price_usdc=float(amount),
                source="fill",
                resource=resource,
                at=float(r.get("settled_at") or 0.0),
                unit=str(r.get("unit") or ""),
                quantity=float(r.get("quantity") or 0.0),
            )
        )
    return out
