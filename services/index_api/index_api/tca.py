"""Machine TCA — transaction-cost analysis for agents, read from the tape.

Every institutional desk runs TCA on its fills. No AI agent ever has, because
there was no benchmark to compare a machine purchase against. ACR publishes one,
and the subgraph records what each payer actually paid against the print they
could have seen when they paid — so the comparison is a query, not a claim.

Everything here reads the **mapping-computed** rollups (`SellerDay`, `PayerDay`)
rather than recomputing from raw settlements. That is the point: `slippageBp` is
derived inside the subgraph mappings from indexed chain data, and this layer only
aggregates and grades. If this file computed slippage itself, the number would be
ACR's arithmetic over ACR's data — which is exactly the thing a benchmark is not
allowed to be.

**Unavailable is not zero.** When the subgraph is unset or unreachable, every
surface here says so explicitly. A TCA of "+0 bp" and a TCA of "we could not read
the tape" are different facts, and rendering one as the other is the failure mode
that would matter most.
"""

from __future__ import annotations

import logging
import time

from acr_core import get_settings
from acr_tape import graph_query

log = logging.getLogger("index_api.tca")

#: Below this many benchmarked settlements a grade is noise. "Unrated (thin
#: tape)" is an honest answer; a letter derived from nine fills is not.
MIN_RATED_N = 20

#: Rating weights, per the published methodology. Components that no data
#: supports yet are marked unavailable and their weight is EXCLUDED from the
#: normalisation rather than silently scored zero — a seller must not be marked
#: down for a signal ACR has not started collecting.
WEIGHTS = {
    "fairness": 40,
    "cleanliness": 25,
    "human_depth": 20,
    "attestation_freshness": 15,
}

# Two variables for one address, deliberately: `where:` filters a relation by
# Bytes, while the singular entity query takes ID!. Passing one Bytes! variable
# to both is the kind of type slip graph-node may coerce through or may reject —
# and a rejection here degrades to "the subgraph did not answer", which reads
# exactly like an outage.
_SELLER_DAYS = """
query SellerDays($seller: Bytes!, $sellerId: ID!, $since: Int!) {
  sellerDays(where: { seller: $seller, day_gte: $since }, orderBy: day, orderDirection: desc, first: 400) {
    day volume bmVolume wSlipTenthBp humanVolume synthVolume realVolume
    n nAll nStale b0 b1 b2 b3 b4 b5 b6
  }
  seller(id: $sellerId) {
    id distinctPayers distinctHumans totalVolume benchmarkedVolume settlementCount
    latestAttestation { modelClass latencySloMs timestamp blockTime }
  }
}
"""

_PAYER_DAYS = """
query PayerDays($payer: Bytes!, $since: Int!) {
  payerDays(where: { payer: $payer, day_gte: $since }, orderBy: day, orderDirection: desc, first: 400) {
    day spent bmSpent wSlipTenthBp overpay n nAll
  }
  settlements(
    where: { payer: $payer, benchmarked: true }
    orderBy: settledAt orderDirection: desc first: 500
  ) {
    seller { id } amount slippageTenthBp synthetic index
  }
}
"""


def _cfg() -> tuple[str, str]:
    s = get_settings()
    return s.subgraph_url, s.graph_api_key


def _unavailable(reason: str) -> dict:
    return {"available": False, "reason": reason, "source": "subgraph"}


def _day_now() -> int:
    return int(time.time()) // 86400


def _vw_bp(weighted_tenth_bp: int, benchmarked_volume: int) -> float | None:
    """Volume-weighted slippage in basis points, or None when nothing is graded.

    Divided from the tenth-bp figure the mapping accumulated, never from a
    per-settlement value already rounded to whole bp.
    """
    if benchmarked_volume <= 0:
        return None
    return weighted_tenth_bp / benchmarked_volume / 10.0


def _p50_bp(buckets: list[int]) -> float | None:
    """Median slippage, interpolated from the histogram.

    The subgraph stores no median — a median cannot be summed, so it cannot be
    rolled up. Interpolating from counts is the standard answer and it keeps the
    rollup associative, which is what lets a day be assembled settlement by
    settlement.
    """
    edges = [-float("inf"), -100, 0, 50, 100, 200, 500, float("inf")]
    total = sum(buckets)
    if total == 0:
        return None
    target = total / 2.0
    seen = 0
    for i, count in enumerate(buckets):
        if count == 0:
            continue
        if seen + count >= target:
            lo, hi = edges[i], edges[i + 1]
            # Open-ended tails have no width to interpolate across; report the
            # edge rather than an invented interior point.
            if lo == -float("inf"):
                return -100.0
            if hi == float("inf"):
                return 500.0
            return lo + (hi - lo) * ((target - seen) / count)
        seen += count
    return None


def seller_rating(seller: str, days: int = 7) -> dict:
    """Grade a seller from the tape. Always carries `n` and the synthetic share."""
    url, key = _cfg()
    if not url:
        return _unavailable("ACR_SUBGRAPH_URL is unset")
    data = graph_query(
        url,
        _SELLER_DAYS,
        {"seller": seller.lower(), "sellerId": seller.lower(), "since": _day_now() - days},
        key,
    )
    if not data:
        return _unavailable("the subgraph did not answer")

    rows = data.get("sellerDays") or []
    entity = data.get("seller") or {}
    volume = sum(int(r["volume"]) for r in rows)
    bm_volume = sum(int(r["bmVolume"]) for r in rows)
    w_slip = sum(int(r["wSlipTenthBp"]) for r in rows)
    synth = sum(int(r["synthVolume"]) for r in rows)
    human_volume = sum(int(r["humanVolume"]) for r in rows)
    n = sum(int(r["n"]) for r in rows)
    n_all = sum(int(r["nAll"]) for r in rows)
    buckets = [sum(int(r[f"b{i}"]) for r in rows) for i in range(7)]

    vw = _vw_bp(w_slip, bm_volume)
    p50 = _p50_bp(buckets)
    synthetic_share = (synth / volume) if volume else None

    components: dict[str, dict] = {}

    # Fairness — the only component the tape fully supports today.
    if vw is None:
        components["fairness"] = {"available": False, "reason": "no benchmarked volume"}
    else:
        # 0 bp → full marks; +200 bp → zero. Linear, clamped, and stated rather
        # than tuned: an opaque curve here would be a policy nobody could check.
        score = max(0.0, min(1.0, 1.0 - (vw / 200.0)))
        components["fairness"] = {
            "available": True, "score": round(score, 4),
            "vw_slippage_bp": round(vw, 1),
            "p50_slippage_bp": None if p50 is None else round(p50, 1),
        }

    # Cleanliness — needs re-derived wash flags on the tape, which the subgraph
    # does not carry yet. Excluded from the normalisation rather than scored 0.
    components["cleanliness"] = {
        "available": False,
        "reason": "no re-derived wash flags on the tape yet (needs policyHash on chain)",
    }

    # Human depth — needs AgentBook humanIds, which nothing resolves yet.
    if entity.get("distinctHumans"):
        depth = int(entity["distinctHumans"]) / max(1, int(entity.get("distinctPayers") or 1))
        components["human_depth"] = {
            "available": True, "score": round(min(1.0, depth), 4),
            "distinct_humans": int(entity["distinctHumans"]),
            "human_volume_share": round(human_volume / volume, 4) if volume else None,
        }
    else:
        components["human_depth"] = {
            "available": False, "reason": "no humanId resolutions on the tape yet"
        }

    att = entity.get("latestAttestation")
    if att:
        age_days = (time.time() - int(att["blockTime"])) / 86400
        components["attestation_freshness"] = {
            "available": True,
            "score": round(max(0.0, min(1.0, 1.0 - age_days / 30.0)), 4),
            "age_days": round(age_days, 1),
        }
    else:
        components["attestation_freshness"] = {
            "available": False, "reason": "seller has never attested"
        }

    covered = sum(WEIGHTS[k] for k, c in components.items() if c.get("available"))
    earned = sum(WEIGHTS[k] * c["score"] for k, c in components.items() if c.get("available"))
    score = (earned / covered) if covered else None

    rated = n >= MIN_RATED_N and score is not None
    return {
        "available": True,
        "source": "subgraph",
        "seller": seller,
        "window_days": days,
        # Everything a reader needs to discount the grade themselves.
        "n": n,
        "n_all": n_all,
        "volume_usdc": volume / 1e6,
        "synthetic_share": None if synthetic_share is None else round(synthetic_share, 4),
        "grade": _grade(score) if rated else "Unrated",
        "unrated_reason": None if rated else f"thin tape (n={n} < {MIN_RATED_N})",
        "score": None if score is None else round(score, 4),
        # The share of the published methodology this grade actually rests on.
        # A grade over 55% of the weights is not the same claim as one over 100%.
        "weight_covered_pct": covered,
        "components": components,
        "histogram": {f"b{i}": buckets[i] for i in range(7)},
    }


def _grade(score: float | None) -> str:
    if score is None:
        return "Unrated"
    if score >= 0.85:
        return "A"
    if score >= 0.70:
        return "B"
    if score >= 0.50:
        return "C"
    return "D"


def payer_tca(payer: str, days: int = 7) -> dict:
    """What this payer's purchases cost against the benchmark."""
    url, key = _cfg()
    if not url:
        return _unavailable("ACR_SUBGRAPH_URL is unset")
    data = graph_query(
        url, _PAYER_DAYS, {"payer": payer.lower(), "since": _day_now() - days}, key
    )
    if not data:
        return _unavailable("the subgraph did not answer")

    rows = data.get("payerDays") or []
    spent = sum(int(r["spent"]) for r in rows)
    bm_spent = sum(int(r["bmSpent"]) for r in rows)
    w_slip = sum(int(r["wSlipTenthBp"]) for r in rows)
    overpay = sum(int(r["overpay"]) for r in rows)
    n = sum(int(r["n"]) for r in rows)
    n_all = sum(int(r["nAll"]) for r in rows)

    # Per-seller breakdown, from the payer's own settlements.
    per_seller: dict[str, dict] = {}
    for st in data.get("settlements") or []:
        sid = str(st["seller"]["id"])
        amount = int(st["amount"])
        slip = int(st["slippageTenthBp"] or 0)
        e = per_seller.setdefault(
            sid, {"seller": sid, "volume": 0, "weighted": 0, "n": 0, "synthetic": 0}
        )
        e["volume"] += amount
        e["weighted"] += amount * slip
        e["n"] += 1
        e["synthetic"] += amount if st.get("synthetic") else 0

    breakdown = []
    for e in per_seller.values():
        vw = _vw_bp(e["weighted"], e["volume"])
        breakdown.append({
            "seller": e["seller"],
            "vw_slippage_bp": None if vw is None else round(vw, 1),
            "volume_usdc": e["volume"] / 1e6,
            "volume_share": round(e["volume"] / spent, 4) if spent else None,
            "n": e["n"],
            "synthetic_share": round(e["synthetic"] / e["volume"], 4) if e["volume"] else None,
        })
    breakdown.sort(key=lambda b: (b["vw_slippage_bp"] is None, -(b["vw_slippage_bp"] or 0)))

    return {
        "available": True,
        "source": "subgraph",
        "payer": payer,
        "window_days": days,
        "purchases": n_all,
        "benchmarked": n,
        "spent_usdc": spent / 1e6,
        "vw_slippage_bp": None if _vw_bp(w_slip, bm_spent) is None
        else round(_vw_bp(w_slip, bm_spent), 1),
        "overpaid_usdc": overpay / 1e6,
        "by_seller": breakdown,
        "reroute": _reroute(breakdown),
    }


def _reroute(breakdown: list[dict]) -> dict | None:
    """The suggestion, stated as a suggestion.

    Moving volume from the worst seller to the best is arithmetic on past fills;
    it is not a promise about future ones, and the payload says so rather than
    letting a caller read an estimate as a guarantee.
    """
    priced = [b for b in breakdown if b["vw_slippage_bp"] is not None and b["n"] > 0]
    if len(priced) < 2:
        return None
    worst, best = priced[0], priced[-1]
    if worst["seller"] == best["seller"] or worst["vw_slippage_bp"] <= best["vw_slippage_bp"]:
        return None
    saving_bp = worst["vw_slippage_bp"] - best["vw_slippage_bp"]
    return {
        "from": worst["seller"],
        "to": best["seller"],
        "saving_bp": round(saving_bp, 1),
        "saving_usdc": round(worst["volume_usdc"] * saving_bp / 1e4, 6),
        "basis": "past fills in this window",
        "note": "a suggestion, not a promise",
    }
