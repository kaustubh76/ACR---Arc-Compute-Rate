"""The one transport: every query counted, repeats served from a short cache.

The Graph's Studio dashboard counts gateway queries made with an API key; the
development URL production has been using is capped at 3,000 a day and shows
on no dashboard at all. So the transport keeps its own ledger, and the cache is
what keeps a dozen viewers polling twelve ratings from spending that cap.
"""

from __future__ import annotations

import io
import json

import pytest
from acr_tape import graph_client
from acr_tape.graph_client import graph_query, transport_info, via_of


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture(autouse=True)
def _fresh():
    graph_client._reset_for_tests()
    yield
    graph_client._reset_for_tests()


def _stub(monkeypatch, payload: dict, calls: list):
    def fake(req, timeout=0):
        calls.append(json.loads(req.data.decode()))
        return _Resp(json.dumps(payload).encode())

    monkeypatch.setattr(graph_client.urllib.request, "urlopen", fake)


def test_every_query_is_counted_and_a_repeat_is_a_cache_hit_not_a_query(monkeypatch):
    calls: list = []
    _stub(monkeypatch, {"data": {"_meta": {"block": {"number": 7}}}}, calls)
    url = "https://api.studio.thegraph.com/query/1/x/v0.2.0"
    a = graph_query(url, "{ _meta { block { number } } }", {})
    b = graph_query(url, "{ _meta { block { number } } }", {})
    c = graph_query(url, "{ _meta { block { number } } }", {"first": 1})
    assert a == b == c == {"_meta": {"block": {"number": 7}}}
    assert len(calls) == 2, "same query+variables reused; different variables is a new query"
    t = transport_info(url)
    assert (t["queries"], t["cache_hits"], t["errors"]) == (2, 1, 0)
    assert t["via"] == "studio-dev" and t["daily_cap"] == 3000 and t["host"] == "api.studio.thegraph.com"
    assert t["last_latency_ms"] is not None and t["last_at"] is not None


def test_errors_are_counted_and_never_cached(monkeypatch):
    calls: list = []
    _stub(monkeypatch, {"errors": [{"message": "bad"}]}, calls)
    url = "https://gateway.thegraph.com/api/subgraphs/id/Qm"
    assert graph_query(url, "{ x }", {}, api_key="k") == {}
    assert graph_query(url, "{ x }", {}, api_key="k") == {}
    assert len(calls) == 2, "a failure is retried, not remembered"
    t = transport_info(url)
    assert t["errors"] == 2 and t["queries"] == 2 and t["cache_hits"] == 0
    assert t["via"] == "gateway" and t["daily_cap"] is None


def test_the_two_paths_are_told_apart_by_host():
    assert via_of("https://api.studio.thegraph.com/query/1758707/ethonline/v0.2.0") == "studio-dev"
    assert via_of("https://gateway.thegraph.com/api/subgraphs/id/QmX") == "gateway"
    assert via_of("https://gateway-arbitrum.network.thegraph.com/api/k/subgraphs/id/QmX") == "gateway"
    assert via_of("https://example.org/graphql") == "custom"
    assert via_of("") == "unset"


def test_the_pace_is_the_last_hour_times_24_and_nothing_before_ten_minutes(monkeypatch):
    """Boot-average × 86 400 turned a deploy's first-minute burst into an
    11,000/day alarm on every restart. The pace is now the last hour × 24, and
    nothing is claimed under ten minutes of uptime."""
    calls: list = []
    _stub(monkeypatch, {"data": {"ok": 1}}, calls)
    url = "https://api.studio.thegraph.com/query/1/x/v0.2.0"
    for i in range(5):
        graph_query(url, "{ ok }", {"i": i})
    t = transport_info(url)
    assert t["measuring"] is True and t["pace_per_day"] is None and t["last_hour"] == 5
    # Ten minutes in: the same five queries are a pace of 120 a day, not 4 million.
    monkeypatch.setitem(graph_client._ledger, "started_at", graph_client.time.time() - 601)
    t = transport_info(url)
    assert t["measuring"] is False and t["pace_per_day"] == 5 * 24
    # An hour-old query falls out of the window.
    graph_client._recent.appendleft(graph_client.time.time() - 3_700)
    assert transport_info(url)["last_hour"] == 5
