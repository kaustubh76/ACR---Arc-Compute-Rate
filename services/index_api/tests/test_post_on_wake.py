"""The post-on-wake decision: an overdue on-chain record triggers an immediate
startup post; a fresh one does not. (The wiring in ``_background`` mirrors the
timer body verbatim and is additionally gated on ``can_post()`` — with no signer
configured the decision function is never consulted.)"""

from __future__ import annotations

import time

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


# --- the off-cycle republish, which is what closes a gap the timer misses ----


def _fake_poster(can_post=True, posts=None):
    class _Client:
        def can_post(self):
            return can_post

    class _P:
        client = _Client()

        def post_latest(self):
            (posts if posts is not None else []).append(1)
            return ["0xdeadbeef"]

    return _P()


def _fake_reader(age_s: float):
    class _R:
        configured = True

        def read_all(self, use_cache=True):
            return {"ACR-INF": _print(time.time() - age_s)}

    return _R()


def _settings(refresh=HOUR):
    return type("S", (), {"refresh_seconds": refresh})()


def test_a_stale_chain_record_is_republished_off_cycle(monkeypatch):
    """The recovery path. The hourly timer is the normal one; this is what
    happens when a post FAILED or the process slept through its slot. Before it
    existed, one missed post meant waiting a full hour — and an hour is most of
    the contract's 120-minute settle window, which is how a 216-minute gap left
    the venue unsettleable."""
    import asyncio

    from index_api import app

    monkeypatch.setattr(app, "_last_overdue_attempt", 0.0)
    posts: list = []
    asyncio.run(
        app._post_if_overdue(
            app.store, _fake_poster(posts=posts), _fake_reader(age_s=3 * HOUR), _settings()
        )
    )
    assert posts, "a print three hours stale was not republished"


def test_a_fresh_chain_record_is_left_alone(monkeypatch):
    """It must key off the CHAIN, not our own timer — and a fresh record means
    there is nothing to do, however long ago we last posted."""
    import asyncio

    from index_api import app

    monkeypatch.setattr(app, "_last_overdue_attempt", 0.0)
    posts: list = []
    asyncio.run(
        app._post_if_overdue(
            app.store, _fake_poster(posts=posts), _fake_reader(age_s=60), _settings()
        )
    )
    assert not posts, "a one-minute-old print was republished for no reason"


def test_the_cooldown_stops_a_failing_press_from_hammering(monkeypatch):
    """Without a floor, a press that cannot post (a 429, a dry wallet) would be
    retried on every 60s warm tick — spending gas and RPC budget to fail."""
    import asyncio

    from index_api import app

    monkeypatch.setattr(app, "_last_overdue_attempt", time.time())  # just tried
    posts: list = []
    asyncio.run(
        app._post_if_overdue(
            app.store, _fake_poster(posts=posts), _fake_reader(age_s=3 * HOUR), _settings()
        )
    )
    assert not posts, "it retried inside the cooldown"


def test_an_offline_press_is_not_asked_to_post(monkeypatch):
    import asyncio

    from index_api import app

    monkeypatch.setattr(app, "_last_overdue_attempt", 0.0)
    posts: list = []
    asyncio.run(
        app._post_if_overdue(
            app.store,
            _fake_poster(can_post=False, posts=posts),
            _fake_reader(age_s=3 * HOUR),
            _settings(),
        )
    )
    assert not posts


def test_the_self_ping_never_raises(monkeypatch):
    """It runs inside the warm loop's try, but a knock that throws would still
    skip the cache warm behind it. Failing to stay awake is the status quo, not
    an error — it must degrade silently."""
    import asyncio

    from index_api import app

    monkeypatch.setattr(app, "SELF_URL", "http://127.0.0.1:1")  # nothing listening
    asyncio.run(app._touch_self())  # must not raise

    monkeypatch.setattr(app, "SELF_URL", "")  # unset is a clean no-op
    asyncio.run(app._touch_self())
