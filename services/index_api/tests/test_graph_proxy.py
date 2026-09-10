"""Read-proxy tests — an allowlist, not a passthrough."""

from __future__ import annotations

from fastapi.testclient import TestClient
from index_api import graph_proxy
from index_api.app import app

client = TestClient(app)


def test_the_operations_are_published():
    body = client.get("/graph/operations").json()
    assert set(body["operations"]) == set(graph_proxy.OPERATIONS)
    assert body["max_first"] == graph_proxy.MAX_FIRST


def test_an_unknown_operation_is_refused_and_says_what_is_allowed():
    """Reported before any server-config complaint: an unknown operation is the
    caller's mistake, and masking it sends them looking in the wrong place."""
    out = graph_proxy.run("dropTables")
    assert out["available"] is False
    assert "unknown operation" in out["reason"]
    assert "settlements" in out["operations"]


def test_no_caller_supplied_query_text_is_ever_forwarded(monkeypatch):
    """The point of the allowlist. A proxy that forwarded arbitrary GraphQL is
    the Studio key with extra steps."""
    seen = {}

    def _capture(url, query, variables, api_key="", **kw):
        seen["query"] = query
        return {"_meta": {"block": {"number": "1"}}}

    monkeypatch.setattr(graph_proxy, "graph_query", _capture)
    monkeypatch.setattr(
        graph_proxy, "get_settings",
        lambda: type("S", (), {"subgraph_url": "https://x", "graph_api_key": ""})(),
    )
    graph_proxy.run("meta", {"query": "{ evil }", "operation": "{ evil }"})
    assert "evil" not in seen["query"]
    assert seen["query"] is graph_proxy.OPERATIONS["meta"]


def test_first_is_clamped_rather_than_rejected(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        graph_proxy, "graph_query",
        lambda url, query, variables, api_key="", **kw: seen.update(variables) or {"sellers": []},
    )
    monkeypatch.setattr(
        graph_proxy, "get_settings",
        lambda: type("S", (), {"subgraph_url": "https://x", "graph_api_key": ""})(),
    )
    out = graph_proxy.run("sellers", {"first": 10_000})
    assert seen["first"] == graph_proxy.MAX_FIRST
    assert out["clamped"] is True


def test_addresses_are_lowercased_so_a_checksummed_paste_still_matches(monkeypatch):
    """The mappings index addresses lower-cased. Without this a caller pasting a
    checksummed address gets an empty result that looks like 'no trades'."""
    seen = {}
    monkeypatch.setattr(
        graph_proxy, "graph_query",
        lambda url, query, variables, api_key="", **kw: seen.update(variables) or {"sellerDays": []},
    )
    monkeypatch.setattr(
        graph_proxy, "get_settings",
        lambda: type("S", (), {"subgraph_url": "https://x", "graph_api_key": ""})(),
    )
    graph_proxy.run("sellerDays", {"seller": "0xAbCdEf0000000000000000000000000000000000"})
    assert seen["seller"] == "0xabcdef0000000000000000000000000000000000"


def test_an_unset_subgraph_says_so_rather_than_returning_empty_data():
    out = graph_proxy.run("meta")
    assert out["available"] is False and "unset" in out["reason"]
