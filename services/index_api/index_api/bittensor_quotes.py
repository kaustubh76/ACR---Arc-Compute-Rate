"""Bittensor as a BACKEND: a dated anchor file in, `Quote`s out.

Nothing in this module talks to Bittensor. `scripts/bittensor_rate.py` fetches
SN51 (Lium, GPU rental) and SN64 (Chutes, inference) and writes a dated basket
under `anchors/_bittensor/`, in the SAME `acr.anchor/1` schema and the SAME unit
(`$/GPU-sec`) the curated `anchors/ACR-GPU/` baskets use. So the integration is
a read, not a pipeline: these rows become ordinary third-party quotes, and `par`,
`assess` and `decide()` consume them without knowing where they came from.

That is the whole point. A comparator ACR assigns itself cannot grade ACR, and
`arc_source.py`/`receipt_source.py` do exactly that. Bittensor supplies prices
nobody here controls. What it does NOT supply is a tape: BCR says plainly that it
reads **listings, not trades**, so every quote here carries `source="catalog"` —
the taxonomy this repo already has for "a published listing", as distinct from
`fill`, "a settlement that actually happened". Labelling these `fill` would
manufacture a tape, which is the one thing the comparator must not do.

WHY AVAILABILITY IS READ HERE AND NOT LATER. Measured on the 2026-10-23 basket:
**13 of 15 rows are fully booked** (`listed_gpus == rented_gpus`). The median
across the whole basket is **$0.42/GPU-hr**; across the two rows with any spare
capacity it is **$4.21**, against **$1.99** for the centralised basket. Publish
the first number and decentralised GPUs look 4.7x cheaper; name the cheapest row
as an alternative and in thirteen of fifteen cases you have told a buyer to rent
something nobody is selling. One unbuyable recommendation discredits a
benchmark, so `available_units` is populated at the point the fact is still in
the data.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

from .par import Quote

log = logging.getLogger("index_api.bittensor_quotes")

#: The schema these files declare. Refused rather than guessed at: a future
#: `acr.anchor/2` may move a field this reader depends on, and a silent
#: best-effort parse of an unknown schema is how a basket half-loads.
SCHEMA = "acr.anchor/1"

#: Published facts that make two rows comparable, copied onto the quote. Kept as
#: a tuple so the set is reviewable in one place rather than inferred from
#: whatever a row happens to carry.
QUALITY_KEYS = ("gpu_class", "vram_gb", "architecture", "model_class", "context_length")


def _epoch(stamp) -> float:
    """An ISO-8601 `fetched_at` as a unix timestamp, or 0.0.

    0.0 rather than `time.time()`: a basket whose stamp cannot be parsed has an
    UNKNOWN age, and substituting now would make the stalest possible file read
    as the freshest.
    """
    if not isinstance(stamp, str) or not stamp.strip():
        return 0.0
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _quality(raw: dict) -> tuple[tuple[str, str], ...]:
    return tuple((k, str(raw[k])) for k in QUALITY_KEYS if raw.get(k) is not None)


def _available(raw: dict) -> float | None:
    """Spare capacity, or ``None`` when the row does not say.

    DERIVED, because the Lium rows publish `listed_gpus` and `rented_gpus` and
    not `available_gpus` — verified against the 2026-10-23 basket, where no row
    carries the latter. `None` when either side is missing, never 0: an absent
    count is not a sold-out card, and treating it as one would silently empty
    the basket the first time the upstream shape changed.
    """
    listed, rented = raw.get("listed_gpus"), raw.get("rented_gpus")
    if listed is None or rented is None:
        return None
    try:
        return max(0.0, float(listed) - float(rented))
    except (TypeError, ValueError):
        return None


def quotes_from_basket(basket: dict, resource: str = "") -> list[Quote]:
    """Every priced row of one dated Bittensor basket, as `Quote`s.

    The row `id` becomes the seller. It is a MODEL NAME ("A100 80GB PCIe"), not
    an address, and that is deliberate: `Par.best_source` exists precisely
    because "a market row names a model, which is exactly what makes it
    checkable and exactly what makes it unroutable", and `decide()` already has
    a rung for a cheaper price with no payable counterparty. A fabricated
    address would defeat both.
    """
    got = str(basket.get("schema") or "")
    if got != SCHEMA:
        raise ValueError(f"unsupported basket schema {got!r}; this reader handles {SCHEMA}")

    unit = str(basket.get("unit") or "")
    # The basket's own fetch time, carried onto every quote. A price with no age
    # is the failure `anchors/GAP.md` and `a-number-that-does-not-say-its-age`
    # both exist about, and these rows go stale fast: in five days SN51 went
    # 15 -> 24 live models and its spread 133x -> 49x.
    at = _epoch(basket.get("fetched_at"))
    out: list[Quote] = []
    for row in basket.get("rows") or []:
        price = row.get("price_usd_per_unit")
        if not isinstance(price, (int, float)) or price <= 0:
            continue
        raw = row.get("raw") or {}
        src = row.get("source") or {}
        out.append(
            Quote(
                seller=str(row.get("id") or "").strip(),
                price_usdc=float(price),
                # A published listing. NOT a fill: BCR reads listings, not trades.
                source="catalog",
                resource=resource,
                unit=unit,
                at=at,
                label=str(row.get("label") or row.get("id") or ""),
                url=str(src.get("url") or ""),
                cite=str(src.get("json_path") or src.get("quoted") or ""),
                available_units=_available(raw),
                quality=_quality(raw),
                # Bittensor is not our fleet. `first_party` is a disclosure that
                # a seller is OURS, and claiming it here would understate the
                # independence that makes this basket worth having.
                first_party=False,
            )
        )
    if not out:
        log.warning("bittensor: basket %s carried no priced rows", basket.get("index_id"))
    return out


def latest_basket(index_id: str = "BCR-GPU", root: Path | None = None) -> tuple[dict, Path] | None:
    """The newest dated file for one index, and where it came from.

    Returns the PATH beside the basket because every figure this product
    publishes carries its provenance, and "the Bittensor median" with no file
    behind it is the kind of number `anchors/GAP.md` exists to prevent.
    """
    base = root or (Path(__file__).resolve().parents[3] / "anchors" / "_bittensor")
    folder = base / index_id
    if not folder.is_dir():
        return None
    dated = sorted(p for p in folder.glob("*.json") if p.is_file())
    if not dated:
        return None
    newest = dated[-1]
    try:
        return json.loads(newest.read_text(encoding="utf-8")), newest
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("bittensor: %s unreadable (%s)", newest, exc)
        return None
