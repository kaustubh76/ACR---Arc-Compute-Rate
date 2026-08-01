"""The desk's rate limiter — the guard on an unauthenticated public endpoint.

The bound on key count is as load-bearing as the limit itself: these keys come
from caller-supplied headers, so a limiter that grows forever is the denial of
service it was added to prevent.
"""

from __future__ import annotations

from index_api.ratelimit import DESK_BUDGETS, RateLimiter, client_key


def test_allows_up_to_the_limit_then_refuses():
    lim = RateLimiter()
    assert all(lim.allow("k", 3, 60.0, now=0.0) for _ in range(3))
    assert not lim.allow("k", 3, 60.0, now=0.0)


def test_keys_are_independent():
    lim = RateLimiter()
    assert lim.allow("a", 1, 60.0, now=0.0)
    assert not lim.allow("a", 1, 60.0, now=0.0)
    assert lim.allow("b", 1, 60.0, now=0.0)  # one caller can't exhaust another


def test_the_window_expires():
    lim = RateLimiter()
    assert lim.allow("k", 1, 60.0, now=0.0)
    assert not lim.allow("k", 1, 60.0, now=59.0)
    assert lim.allow("k", 1, 60.0, now=61.0)


def test_key_table_is_bounded_and_evicts_least_recently_used():
    lim = RateLimiter(max_keys=4)
    for i in range(50):
        lim.allow(f"k{i}", 1, 60.0, now=0.0)
    assert len(lim._hits) <= 4


def test_client_key_prefers_the_original_hop():
    class _Req:
        headers = {"x-forwarded-for": "203.0.113.7, 10.0.0.1"}
        client = type("C", (), {"host": "10.0.0.1"})()

    assert client_key(_Req()) == "203.0.113.7"


def test_client_key_falls_back_to_the_peer():
    class _Req:
        headers: dict[str, str] = {}
        client = type("C", (), {"host": "198.51.100.4"})()

    assert client_key(_Req()) == "198.51.100.4"


def test_the_money_endpoints_are_the_strictest():
    """A budget regression here is a funding leak, not a nuisance."""
    faucet, _ = DESK_BUDGETS["faucet"]
    session, _ = DESK_BUDGETS["session"]
    reads, _ = DESK_BUDGETS["limits"]
    assert faucet <= session < reads
