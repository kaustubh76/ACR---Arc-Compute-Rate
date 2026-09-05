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
PAYLOAD_CORE_KEYS = {
    "futures","prints", "history", "sellers", "attack", "oracle", "chain"}


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
    # Shape, not a magic count: the live catalog gained one listing per fleet
    # seller, and an exact number here would only say when the bundle was last
    # regenerated. What the offline page actually needs is that every row it
    # renders is payable-looking, so assert that of ALL of them.
    catalog_items = market["catalog"]["items"]
    assert len(catalog_items) >= 13, "bundled catalog is missing index resources"
    for item in catalog_items:
        assert item["resource"], "a catalog row with no resource renders as a dead link"
        acc = item["accepts"][0]
        assert acc["scheme"] == "exact"
        assert acc["payTo"].startswith("0x")
        assert int(acc["amount"]) > 0
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


def test_fallback_futures_sections_are_not_silently_empty():
    """The archived venue must actually contain a venue.

    `capture_futures_trades` swallows every exception and returns [], and the
    payload emits {} for `futures` when no venue is configured — so a snapshot
    run without ACR_FUTURES_ADDRESS, or against a throttled RPC, writes a
    syntactically perfect bundle with the desk and the tape deleted. Presence
    checks pass on both; only content tells them apart, and the offline terminal
    is where the difference shows.
    """
    snapshot = json.loads(FALLBACK.read_text())
    desks = snapshot.get("futures") or {}
    assert desks, "fallback.json has no futures desks — a snapshot ran without a venue"
    for index_id, row in desks.items():
        assert row.get("multiplier", 0) > 0, f"{index_id}: multiplier must be real"
        assert isinstance(row.get("series_id"), int), f"{index_id}: needs a series id"
        assert not row.get("settled"), f"{index_id}: archived a SETTLED series as the desk"

    trades = snapshot.get("futures_trades") or []
    assert trades, "fallback.json has an empty futures tape — the archive shows a dead venue"
    # Distinct blocks are what makes the archived tape a series rather than a
    # column: every row shares one `seen_at` (the snapshot stamp), so block
    # height is the only ordering the offline chart can trust.
    assert len({t["block"] for t in trades}) > 1, "archived fills must span more than one block"

    # The desks and the tape must describe the SAME venue. `markSeries` in
    # apps/terminal/lib/futuresBook.ts filters the tape to each desk's current
    # series, so a bundle pairing live desks with a stale tape matches nothing
    # and renders an empty venue on every desk — while passing every assertion
    # above, because the tape is non-empty and the desks are real. That is the
    # exact hole `carry_venue_forward` closes by moving the two together, and
    # this is what stops a later edit from splitting them again.
    desk_series = {row["series_id"] for row in desks.values()}
    tape_series = {t["series_id"] for t in trades}
    assert desk_series & tape_series, (
        f"no desk series {sorted(desk_series)} appears in the tape "
        f"{sorted(tape_series)} — the offline venue would render no fills at all"
    )


def test_fallback_hedger_section_still_carries_its_agent():
    """The archived edition must keep the product's protagonist.

    `build_hedger_state` reports `configured: false` with every standing null
    when the agent's address is unset, and `capture_hedger_state` swallows any
    exception into the same shape — so a snapshot run without the two addresses
    writes a syntactically perfect bundle with the autonomous agent deleted.
    That is exactly what the committed bundle did: a live venue address beside
    `configured: false`, because `venue` resolved through ACRSettings (which
    reads `.env`) while the agent addresses came from raw os.environ. Presence
    checks pass on both; only content tells them apart, and offline — a judge
    loading the page while the free-tier API sleeps — is where it shows.
    """
    snapshot = json.loads(FALLBACK.read_text())
    h = snapshot.get("hedger") or {}
    assert h.get("configured"), "fallback.json archived an unconfigured hedger"
    # Two addresses, one agent (docs/WALLETS.md): the smart account trades, the
    # backing EOA pays. One without the other is half an agent, and they are
    # genuinely different addresses — matching the ledger on the SCA would
    # report a paying agent as having paid nothing.
    assert h.get("agent") and h.get("payer"), "the hedger needs BOTH identities"
    assert h["agent"].lower() != h["payer"].lower(), "the SCA is not its own EOA"
    assert h.get("venue") and isinstance(h.get("series_id"), int)
    assert h.get("position_contracts") is not None, "archived a position that never read"

    # Both legs of the loop. `receipts: null` means the ledger was not read at
    # all, which is a different and worse archive than one with no rows — the
    # panel renders those as different sentences, and so does this.
    rows = h.get("receipts")
    assert rows, "the archived hedger bought nothing — half the loop is missing"
    assert all(r["tx_ref"] and r["amount_usdc"] > 0 for r in rows), "empty receipt rows"
    # Newest first, so the panel's five-row window is the five most RECENT
    # payments. The committed ledger is append-ordered by capture, not by
    # settlement (of its seven hedger rows the newest by `settled_at` sits fifth
    # from the top), so this is a real property of the builder rather than an
    # accident of the file.
    stamps = [r["settled_at"] for r in rows if r.get("settled_at")]
    assert stamps == sorted(stamps, reverse=True), "receipts must be newest-first"
    # The counter above the table and the table itself must tell one story: the
    # rows are capped, the count is not.
    assert h["paid_queries"] >= len(rows) >= 1
    assert h["spent_usdc"] >= round(sum(r["amount_usdc"] for r in rows), 6) - 1e-9
