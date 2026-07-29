"""The post-on-wake decision: an overdue on-chain record triggers an immediate
startup post; a fresh one does not. (The wiring in ``_background`` mirrors the
timer body verbatim and is additionally gated on ``can_post()`` — with no signer
configured the decision function is never consulted.)"""

from __future__ import annotations

from index_api.app import _overdue_for_startup_post

HOUR = 3600.0
NOW = 1_785_000_000.0


def _print(posted_at: float) -> dict:
    return {"index_id": "ACR-INF", "value": 0.5, "posted_at": posted_at}


def test_no_onchain_record_is_overdue():
    # Never posted at all → the first boot should post immediately.
    assert _overdue_for_startup_post({}, HOUR, NOW)


def test_stale_record_is_overdue():
    # Slept through days of hourly slots (the Render free-tier failure mode).
    assert _overdue_for_startup_post({"ACR-INF": _print(NOW - 2 * 86_400)}, HOUR, NOW)


def test_fresh_record_is_not_overdue():
    # Posted within the current cycle → wait for the timer as before.
    assert not _overdue_for_startup_post({"ACR-INF": _print(NOW - 60)}, HOUR, NOW)


def test_boundary_is_not_overdue():
    # Exactly one refresh old is on-schedule, not overdue (strict >).
    assert not _overdue_for_startup_post({"ACR-INF": _print(NOW - HOUR)}, HOUR, NOW)


def test_newest_print_governs():
    # One fresh index keeps the press on-schedule even if another lags — the
    # timer cycle (which posts all indices) is at most one refresh away.
    onchain = {"ACR-INF": _print(NOW - 3 * HOUR), "ACR-GPU": _print(NOW - 60)}
    assert not _overdue_for_startup_post(onchain, HOUR, NOW)


def test_missing_posted_at_counts_as_never():
    assert _overdue_for_startup_post({"ACR-INF": {"index_id": "ACR-INF"}}, HOUR, NOW)
