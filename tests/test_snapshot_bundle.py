"""Snapshot-drift guard — the bundled Terminal snapshot must carry every
section the proxy routes read via ``bundleSection``.

The failure mode this catches: a backend session adds a section to
``gen_snapshot.embed_bundle_sections`` (or the terminal payload) but nobody
re-runs ``make snapshot`` — offline, the Terminal then silently renders empty
exchange/revenue/console surfaces. The expected key set is derived from the
REAL ``embed_bundle_sections`` (not hardcoded), so new sections are enforced
automatically.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "scripts"))

from gen_snapshot import embed_bundle_sections  # noqa: E402

FALLBACK = _ROOT / "apps/terminal/lib/fallback.json"

#: Keys build_terminal_payload always emits (stable core; the drift-prone
#: bundle sections are derived dynamically below).
PAYLOAD_CORE_KEYS = {"prints", "history", "sellers", "attack", "oracle", "chain"}


def _bundle_keys() -> set[str]:
    """The section keys the snapshot embeds, from the real builder (hermetic —
    dev gate + settings defaults, no chain, no credentials)."""
    return set(embed_bundle_sections({}).keys())


def test_fallback_json_carries_every_bundle_section():
    snapshot = json.loads(FALLBACK.read_text())
    expected = PAYLOAD_CORE_KEYS | _bundle_keys()
    missing = expected - set(snapshot)
    assert not missing, (
        f"fallback.json is stale — missing sections {sorted(missing)}; run `make snapshot`"
    )


def test_fallback_marketplace_section_is_usable():
    """The offline exchange page renders from these — they must be non-empty
    and shaped like the live endpoints."""
    snapshot = json.loads(FALLBACK.read_text())
    market = snapshot["marketplace"]
    assert len(market["catalog"]["items"]) == 13
    first = market["catalog"]["items"][0]
    assert first["accepts"][0]["scheme"] == "exact"
    receipts = market["receipts"]["receipts"]
    assert receipts, "bundled settlement tape is empty"
    # Honestly labeled sim rows, ordinals not wall-clock (The Fixing rules).
    assert all("timestamp" not in r and "date" not in r for r in receipts)
    assert snapshot["x402"]["price_usdc"] > 0
    assert snapshot["revenue"]["recent"], "bundled revenue ring is empty"


def test_fallback_revenue_counters_agree_with_the_ledger():
    """The offline /developers page shows the revenue counters ABOVE the
    receipts table — they must tell the same story (never $0 over 24 paid
    rows, the self-contradiction this guards against)."""
    snapshot = json.loads(FALLBACK.read_text())
    ledger = snapshot["marketplace"]["receipts"]
    assert snapshot["revenue"]["paid_queries"] == ledger["paid_queries"]
    assert snapshot["revenue"]["revenue_usdc"] == ledger["revenue_usdc"]
