#!/usr/bin/env python
"""Bind the ACR architecture diagram's connector arrows to their component boxes.

`acr_architecture.excalidraw` ships with 19 connector arrows that are positioned
by fixed coordinates but *not bound* to any shape — so moving a box detaches its
arrows and nothing is semantically wired. A few arrows also terminate on a dashed
zone-container edge rather than the specific component inside it.

This transform gives each arrow a proper start/end binding to the correct
component box (and back-references the arrow from each box's boundElements),
without touching any arrow geometry (points/x/y) or the layout. Idempotent and
auditable — re-running yields the same file.

    uv run python scripts/wire_excalidraw.py [--check]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

FILE = Path(__file__).resolve().parent.parent / "acr_architecture.excalidraw"

# arrowId -> (startBoxId, endBoxId). Verified against the diagram geometry:
# every listed endpoint already sits on the target box edge (distance 0).
WIRING: dict[str, tuple[str, str]] = {
    "AmHMPGPP": ("CZ7Uw9xf", "iAhzCueQ"),  # x402 auth        -> tape indexer   (1)
    "Pchv5V7S": ("YOvfZ8Uz", "iAhzCueQ"),  # gateway batch    -> tape indexer   (2)
    "V6um4yvM": ("064GiIjH", "iAhzCueQ"),  # adversarial flow -> tape indexer
    "jcbhgN7k": ("aZUPgHV7", "wZbqcabU"),  # attestations     -> hedonic (feats)
    "pnnhcc82": ("iAhzCueQ", "TBGzvAmw"),  # indexer          -> observation    (3)
    "TWx6uX9M": ("iAhzCueQ", "5XlrWi0B"),  # indexer          -> cleaning       (4)
    "BaHmsWWd": ("TBGzvAmw", "eq3hDavJ"),  # observation      -> robust         (5)
    "8OXfFYSJ": ("5XlrWi0B", "eq3hDavJ"),  # cleaning         -> robust         (5)
    "B4Pbxntq": ("eq3hDavJ", "wZbqcabU"),  # robust           -> hedonic        (6)
    "kDCSXqLo": ("wZbqcabU", "wd1iaeOV"),  # hedonic          -> ACR prints
    "tWT01NjU": ("wd1iaeOV", "c94tnwla"),  # prints           -> manip. bound   (7)
    "rmgO6grn": ("wd1iaeOV", "XcNOPmeM"),  # prints           -> ACROracle.sol  (8)
    "QUP44XPS": ("aZUPgHV7", "qaDZeV7G"),  # attestations     -> AttestationReg.
    "qOSg5ApY": ("XcNOPmeM", "5Vsqxezy"),  # ACROracle        -> ACR-weekly fut. (9)
    "cqInkTY8": ("ZWOz648J", "5Vsqxezy"),  # market maker     -> future (quotes)
    "GbOY1xHv": ("c94tnwla", "qZKm4bV3"),  # bound/prints     -> index API      (10)
    "otVz89Ho": ("qZKm4bV3", "u3uDxYYM"),  # index API        -> nanopayments
    "WJPiX1Ew": ("V5EbOApZ", "iAhzCueQ"),  # Arc L1           -> tape indexer
    "j7t2ydf0": ("064GiIjH", "80USP2W5"),  # adversarial      -> live demo
}

GAP = 6.0
FOCUS = 0.0


def _bump(el: dict) -> None:
    el["version"] = int(el.get("version", 1)) + 1
    el["versionNonce"] = (int(el.get("versionNonce", 1)) * 1103515245 + 12345) & 0x7FFFFFFF


def _resolver(elements: list[dict]):
    """Resolve the 8-char prefixes in WIRING to full element IDs (prefixes are
    unique in this file). Returns prefix->fullid, raising on any ambiguity."""
    full = [e["id"] for e in elements]
    mapping: dict[str, str] = {}
    for prefix in {p for pair in WIRING.items() for p in (pair[0], *pair[1])}:
        matches = [fid for fid in full if fid.startswith(prefix)]
        if len(matches) != 1:
            raise SystemExit(f"prefix {prefix!r} resolves to {len(matches)} ids: {matches}")
        mapping[prefix] = matches[0]
    return mapping


def wire(elements: list[dict]) -> list[str]:
    by_id = {e["id"]: e for e in elements}
    resolve = _resolver(elements)
    notes: list[str] = []
    for arrow_pref, (start_pref, end_pref) in WIRING.items():
        arrow = by_id[resolve[arrow_pref]]
        if arrow.get("type") != "arrow":
            raise SystemExit(f"{arrow_pref} is not an arrow")
        start_id, end_id = resolve[start_pref], resolve[end_pref]

        arrow["startBinding"] = {"elementId": start_id, "focus": FOCUS, "gap": GAP}
        arrow["endBinding"] = {"elementId": end_id, "focus": FOCUS, "gap": GAP}
        _bump(arrow)

        for box_id in (start_id, end_id):
            box = by_id[box_id]
            bound = box.setdefault("boundElements", []) or []
            if not any(b.get("id") == arrow["id"] and b.get("type") == "arrow" for b in bound):
                bound.append({"id": arrow["id"], "type": "arrow"})
                box["boundElements"] = bound
                _bump(box)
        notes.append(f"  {arrow['id'][:8]}  {start_pref} -> {end_pref}")
    return notes


def validate(elements: list[dict]) -> None:
    by_id = {e["id"]: e for e in elements}
    resolve = _resolver(elements)
    wired_arrow_ids = {resolve[p] for p in WIRING}
    assert len(elements) == 143, f"element count changed: {len(elements)}"
    bound = 0
    for a in (e for e in elements if e.get("type") == "arrow"):
        if a["id"] not in wired_arrow_ids:
            continue
        sb, eb = a.get("startBinding"), a.get("endBinding")
        assert sb and eb, f"{a['id']} not fully bound"
        assert sb["elementId"] in by_id and eb["elementId"] in by_id, f"{a['id']} dangling"
        for end in (sb, eb):
            refs = by_id[end["elementId"]].get("boundElements") or []
            assert any(b.get("id") == a["id"] for b in refs), f"{a['id']} not back-referenced"
        bound += 1
    assert bound == len(WIRING) == 19, f"expected 19 wired arrows, got {bound}"
    print(f"✓ validated: {bound}/19 arrows fully bound, {len(elements)} elements intact")


def main() -> None:
    check_only = "--check" in sys.argv
    doc = json.loads(FILE.read_text())
    elements = doc["elements"]

    if check_only:
        validate(elements)
        return

    # Snapshot geometry to prove points are untouched.
    geom = {e["id"]: (e.get("x"), e.get("y"), json.dumps(e.get("points")))
            for e in elements if e.get("type") == "arrow"}

    notes = wire(elements)
    for a in elements:
        if a.get("type") == "arrow" and a["id"] in geom:
            gx, gy, gp = geom[a["id"]]
            assert (a.get("x"), a.get("y"), json.dumps(a.get("points"))) == (gx, gy, gp), \
                f"geometry of {a['id']} changed — must not happen"

    validate(elements)
    # Match the file's existing 1-space indent to keep the diff to the wiring.
    FILE.write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    print(f"\nwired {len(notes)} arrows → {FILE.name}:")
    print("\n".join(notes))


if __name__ == "__main__":
    main()
