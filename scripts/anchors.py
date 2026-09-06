#!/usr/bin/env python
"""Real public prices, dated and cited — and the gap they open.

`IndexSpec.reference_level` calls itself "nominal" and carries no citation. It
seeds the simulator's central level, the fleet's quotes and the tape's price pin,
so it has been the scale of everything this project publishes, resting on three
numbers nobody sourced.

This measures them against real public prices. It does **not** change them:
`--fetch` writes `anchors/` and never touches `indices.py`. Re-anchoring moves
the tape sources' price pin and breaks comparability with the prints already on
chain, so it is a separate decision that deserves its own analysis — and, usefully,
it is one this harness is immune to: the simulator draws notional first and
derives size, so every bp-denominated quality metric is exactly scale-invariant.

    uv run python scripts/anchors.py --fetch     # network; manual, never CI
    uv run python scripts/anchors.py --report    # regenerate anchors/GAP.md
    uv run python scripts/anchors.py --check     # offline; CI-safe

**What --check asserts is that the gap is DECLARED, not that it is small.** A
test that fails on a 1000x gap is red forever and teaches its operator to ignore
it. So it checks three things that can each go wrong silently: that every index
has an anchor at all; that the `reference_level` the anchor was measured against
is still the one in `indices.py` (this goes red the moment someone edits that
file without re-anchoring); and that the declared ratio recomputes from the
file's own rows. The size of the gap is held by a ratchet — widening fails,
narrowing is re-blessed by lowering the ceiling.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from acr_core import ALL_INDEX_IDS, spec_for

ANCHOR_SCHEMA = "acr.anchor/1"
#: Bumped when the aggregation RULE changes, like POLICY_VERSION in cleaning.py.
#: One idiom in this repo for "the rule moved", not two.
TOOL_VERSION = 1

ROOT = Path(__file__).resolve().parents[1]
ANCHOR_DIR = ROOT / "anchors"
BASKET_DIR = ANCHOR_DIR / "_basket"

OPENROUTER_URL = "https://openrouter.ai/api/v1/models"


# ── fetch ───────────────────────────────────────────────────────────────────


def fetch_openrouter(timeout: float = 30.0) -> tuple[list[dict], str]:
    """The catalogue, and a digest of the exact bytes it came from.

    The digest is what makes the fetch auditable without committing 431 models:
    two anchors claiming the same source on the same day should agree on it.
    """
    req = urllib.request.Request(OPENROUTER_URL, headers={"User-Agent": "acr-anchors"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
        raw = r.read()
    sha = "0x" + hashlib.sha256(raw).hexdigest()
    return list(json.loads(raw).get("data") or []), sha


def load_basket(index_id: str) -> dict:
    return json.loads((BASKET_DIR / f"{index_id}.json").read_text())


def _blend(pricing: dict, blend: dict) -> float | None:
    """USD per token under the basket's prompt:completion split."""
    try:
        p = float(pricing.get("prompt") or 0.0)
        c = float(pricing.get("completion") or 0.0)
    except (TypeError, ValueError):
        return None
    if p <= 0:
        return None
    return blend["prompt"] * p + blend["completion"] * c


def aggregate(values: list[float], rule: str = "median", trim: float = 0.0) -> dict:
    """The aggregate, with its dispersion beside it.

    Dispersion is not decoration. A basket whose rows span 13x has no single
    price, and a bare median over it is an average of two different markets — so
    the file states the spread on its face rather than letting one number imply
    a consensus that is not there.
    """
    vs = sorted(values)
    if not vs:
        return {"value": None, "n": 0}
    if trim > 0 and len(vs) > 2:
        k = int(len(vs) * trim)
        vs = vs[k : len(vs) - k] or vs
    value = statistics.median(vs) if rule == "median" else statistics.fmean(vs)
    return {
        "value": value,
        "n": len(values),
        "min": vs[0],
        "p25": vs[len(vs) // 4],
        "p75": vs[(3 * len(vs)) // 4],
        "max": vs[-1],
        "spread_ratio": (vs[-1] / vs[0]) if vs[0] > 0 else None,
    }


def gap_vs_reference(index_id: str, value: float | None) -> dict:
    """How far the nominal reference sits from the measured market."""
    ref = spec_for(index_id).reference_level
    if not value:
        return {"ratio": None, "direction": "unmeasured"}
    ratio = ref / value
    return {
        "ratio": ratio,
        "direction": "reference_above_market" if ratio >= 1 else "reference_below_market",
    }


def build_live_anchor(index_id: str, models: list[dict], sha: str) -> dict:
    """ACR-INF: named rows priced from the live catalogue."""
    basket = load_basket(index_id)
    by_id = {m.get("id"): m for m in models}
    now = datetime.now(UTC).isoformat(timespec="seconds")
    rows, missing = [], []
    for want in basket["rows"]:
        m = by_id.get(want["id"])
        price = _blend(m.get("pricing") or {}, basket["rule"]["blend"]) if m else None
        if price is None:
            # Recorded, never dropped. A basket that quietly shrinks re-medians a
            # different population and reports it as a market move.
            missing.append({"id": want["id"], "reason": "absent from catalogue or unpriced"})
            continue
        rows.append({
            "id": want["id"],
            "label": want["label"],
            "price_usd_per_unit": price * 1000.0,
            # The vendor's own strings. If OpenRouter ever moves from $/token to
            # $/Mtok, a numeric-only file is silently wrong by 1e6 and this makes
            # the change visible in the diff.
            "raw": dict(m.get("pricing") or {}),
            "quality": {"model_class": want.get("model_class")},
            "source": {
                "kind": "http",
                "url": OPENROUTER_URL,
                "json_path": f"data[id={want['id']}].pricing",
                "retrieved_at": now,
            },
        })
    return _assemble(index_id, basket, rows, missing, now, {
        "response_sha256": sha,
        "n_models_in_catalogue": len(models),
        "n_models_priced": sum(1 for m in models if (m.get("pricing") or {}).get("prompt")),
    })


def build_curated_anchor(index_id: str) -> dict:
    """ACR-GPU / ACR-DATA: published rate cards, each row carrying its URL."""
    basket = load_basket(index_id)
    now = datetime.now(UTC).isoformat(timespec="seconds")
    field = "usd_per_gpu_hour" if index_id == "ACR-GPU" else "usd_per_gb"
    divisor = 3600.0 if index_id == "ACR-GPU" else 1000.0
    rows = [{
        "id": r["id"],
        "label": r["label"],
        "price_usd_per_unit": r[field] / divisor,
        "raw": {field: r[field]},
        "quality": {},
        "source": {
            "kind": "curated",
            "url": r["url"],
            "quoted": r["quoted"],
            "retrieved_at": now,
        },
    } for r in basket["rows"]]
    return _assemble(index_id, basket, rows, [], now, {})


def _assemble(index_id, basket, rows, missing, now, provenance) -> dict:
    agg = aggregate([r["price_usd_per_unit"] for r in rows],
                    basket["rule"]["aggregate"], basket["rule"].get("trim", 0.0))
    agg["n_requested"] = len(basket["rows"])
    gap = gap_vs_reference(index_id, agg["value"])
    ratio = gap["ratio"]
    return {
        "schema": ANCHOR_SCHEMA,
        "tool_version": TOOL_VERSION,
        "index_id": index_id,
        "unit": basket["unit"],
        "fetched_at": now,
        "basket_version": basket["version"],
        "selection": basket["rule"],
        "rows": rows,
        "missing": missing,
        "aggregate": agg,
        # Copied in, so the file stays self-contained evidence of the gap AT
        # THIS DATE and does not become a lie after a later re-anchor.
        "reference_level": spec_for(index_id).reference_level,
        "gap": gap,
        # The ratchet: widening fails --check, narrowing is re-blessed by
        # lowering this. 15% of headroom so a normal market move is not an alarm.
        "ceiling": {
            "ratio": round(ratio * 1.15, 1) if ratio else None,
            "set_at": now[:10],
            "note": "measured value plus 15%",
        },
        "provenance": provenance,
    }


# ── read back ───────────────────────────────────────────────────────────────


def latest_anchor(index_id: str) -> dict | None:
    d = ANCHOR_DIR / index_id
    files = sorted(d.glob("*.json")) if d.exists() else []
    return json.loads(files[-1].read_text()) if files else None


def recompute_gap(doc: dict) -> float | None:
    """The gap, recomputed from the file's own rows — catches a hand-edited
    aggregate, which is the one way a committed anchor can lie."""
    agg = aggregate([r["price_usd_per_unit"] for r in doc["rows"]],
                    doc["selection"]["aggregate"], doc["selection"].get("trim", 0.0))
    return gap_vs_reference(doc["index_id"], agg["value"])["ratio"]


def check_anchors(indices=ALL_INDEX_IDS) -> list[str]:
    fails: list[str] = []
    for index_id in indices:
        doc = latest_anchor(index_id)
        if doc is None:
            fails.append(f"{index_id}: no anchor — run `make anchors-fetch`")
            continue
        live_ref = spec_for(index_id).reference_level
        if doc["reference_level"] != live_ref:
            fails.append(
                f"{index_id}: indices.py reference_level is {live_ref} but the anchor "
                f"was measured against {doc['reference_level']} — re-anchor, or the "
                f"published gap describes a level that no longer exists"
            )
        declared = doc["gap"]["ratio"]
        actual = recompute_gap(doc)
        if declared is not None and actual is not None and abs(declared - actual) > 1e-6:
            fails.append(f"{index_id}: declared gap {declared:.1f} does not recompute "
                         f"from its own rows ({actual:.1f})")
        ceiling = (doc.get("ceiling") or {}).get("ratio")
        if declared is not None and ceiling is not None and declared > ceiling:
            fails.append(f"{index_id}: gap {declared:.1f} widened past its ceiling "
                         f"{ceiling} — re-anchor, or raise the ceiling deliberately")
    return fails


def render_gap_report(docs: list[dict]) -> str:
    lines = [
        "# The anchor gap",
        "",
        "*Generated by `make anchors-report`. Do not hand-edit.*",
        "",
        "`IndexSpec.reference_level` describes itself as \"nominal\" and cites nothing.",
        "It sets the scale of every price this project publishes. These are the real",
        "public prices it sits against, and the distance between them.",
        "",
        "**The reference levels are not being changed.** They seed the simulator, the",
        "fleet's quotes and the tape's price pin, so moving them would break",
        "comparability with the prints already on chain. That is a separate decision.",
        "What this file does is stop the gap being invisible.",
        "",
        "The quality metrics are immune to it either way: the simulator draws notional",
        "first and derives size, so every bp-denominated figure is exactly",
        "scale-invariant — measured, by re-anchoring ACR-INF 667x and watching",
        "`attack_acr_err_bp` not move at all.",
        "",
        "| index | reference | market anchor | gap | rows | spread | as of |",
        "|---|---|---|---|---|---|---|",
    ]
    for d in docs:
        a, g = d["aggregate"], d["gap"]
        spread = a.get("spread_ratio")
        lines.append(
            f"| `{d['index_id']}` | {d['reference_level']:g} {d['unit']} | "
            f"{a['value']:.6g} | **{g['ratio']:.0f}x** | {a['n']}/{a['n_requested']} | "
            f"{spread:.1f}x | {d['fetched_at'][:10]} |"
        )
    lines += [
        "",
        "## Why the gap is not one number",
        "",
        "It is a function of the aggregation rule, and the rule swings it several-fold.",
        "For ACR-INF the same catalogue gives roughly 1000x on a prompt-only median,",
        "588x on the 75/25 blend this basket uses, and 335x on a trimmed mean over",
        "every priced model. A gap quoted without its rule is not a measurement, so",
        "each anchor records its `selection` and every row's own source.",
        "",
        "## Per index",
        "",
    ]
    for d in docs:
        lines += [f"### {d['index_id']} — {d['unit']}", ""]
        b = load_basket(d["index_id"])
        lines += [b["note"], "", "| row | price | source |", "|---|---|---|"]
        for r in d["rows"]:
            src = r["source"].get("quoted") or r["source"].get("json_path") or ""
            lines.append(f"| {r['label']} | {r['price_usd_per_unit']:.6g} | "
                         f"[{src}]({r['source']['url']}) |")
        if d["missing"]:
            lines += ["", "Requested but absent on this date: "
                      + ", ".join(f"`{m['id']}`" for m in d["missing"])
                      + ". A basket that shrinks silently re-medians a different population."]
        lines.append("")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fetch", action="store_true", help="hit the network and write today's anchors")
    ap.add_argument("--report", action="store_true", help="regenerate anchors/GAP.md")
    ap.add_argument("--check", action="store_true", help="offline assertions (CI-safe)")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    if args.fetch:
        models, sha = fetch_openrouter()
        print(f"  openrouter: {len(models)} models, sha {sha[:18]}…")
        for index_id in ALL_INDEX_IDS:
            doc = (build_live_anchor(index_id, models, sha) if index_id == "ACR-INF"
                   else build_curated_anchor(index_id))
            out = ANCHOR_DIR / index_id / f"{doc['fetched_at'][:10]}.json"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n")
            a, g = doc["aggregate"], doc["gap"]
            print(f"  {index_id:<9} anchor {a['value']:.6g} {doc['unit']:<14} "
                  f"reference {doc['reference_level']:g}  gap {g['ratio']:.0f}x  "
                  f"({a['n']}/{a['n_requested']} rows)")
        print("\n  reference_level was NOT changed. Re-anchoring is a separate decision.")
        return 0

    if args.report:
        docs = [d for d in (latest_anchor(i) for i in ALL_INDEX_IDS) if d]
        if not docs:
            print("  ✗ no anchors to report — run `make anchors-fetch`")
            return 1
        (ANCHOR_DIR / "GAP.md").write_text(render_gap_report(docs))
        print(f"  wrote anchors/GAP.md ({len(docs)} index(es))")
        return 0

    fails = check_anchors()
    if fails:
        print("  ✗ anchors:")
        for f in fails:
            print(f"    {f}")
        return 1
    for index_id in ALL_INDEX_IDS:
        d = latest_anchor(index_id)
        print(f"  ✓ {index_id:<9} gap {d['gap']['ratio']:.0f}x declared and reproducible "
              f"(ceiling {d['ceiling']['ratio']}, as of {d['fetched_at'][:10]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
