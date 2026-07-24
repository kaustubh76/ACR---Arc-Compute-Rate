"""CircleFacilitator tests — real x402 v2 verify/settle, all mocked (no network).

Mock shapes mirror the confirmed Circle Gateway x402 API:
  POST /v1/x402/verify → {isValid, invalidReason, payer}
  POST /v1/x402/settle → {success, transaction, network, payer} |
                         {success: false, errorReason, ...}
"""

from __future__ import annotations

import asyncio
import base64
import json
import types

import httpx
import pytest
from acr_core.config import ACRSettings
from fastapi import HTTPException, Response
from fastapi.testclient import TestClient
from index_api.x402 import (
    CircleFacilitator,
    DevFacilitator,
    facilitator_endpoint,
    get_facilitator,
    reset_facilitator,
    set_facilitator,
)


def _settings(**over):
    base = dict(x402_facilitator_url="https://fac.example", x402_pay_to="0xSeller", _env_file=None)
    base.update(over)
    return ACRSettings(**base)


def _req(path="/prints"):
    url = types.SimpleNamespace(path=path)
    return types.SimpleNamespace(base_url="http://test/", url=url, state=types.SimpleNamespace())


def _mock_client(verify_json, settle_json, raise_on=None):
    def handler(request: httpx.Request) -> httpx.Response:
        # Exact Gateway x402 API paths — proves facilitator_endpoint() joins right.
        if request.url.path == "/v1/x402/verify":
            if raise_on == "verify":
                raise httpx.ConnectError("boom")
            return httpx.Response(200, json=verify_json)
        if request.url.path == "/v1/x402/settle":
            if raise_on == "settle":
                raise httpx.ConnectError("boom")
            return httpx.Response(200, json=settle_json)
        return httpx.Response(404)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _sig_header(payload: dict) -> str:
    return base64.b64encode(json.dumps(payload).encode()).decode()


def test_facilitator_endpoint_joins_v1_path():
    assert (
        facilitator_endpoint("https://gateway-api-testnet.circle.com", "verify")
        == "https://gateway-api-testnet.circle.com/v1/x402/verify"
    )
    assert facilitator_endpoint("https://gw.example/", "settle") == "https://gw.example/v1/x402/settle"
    # A base that already names the x402 API is used as-is.
    assert facilitator_endpoint("https://gw.example/v1/x402", "verify") == "https://gw.example/v1/x402/verify"
    assert facilitator_endpoint("https://gw.example/v1/x402/", "settle") == "https://gw.example/v1/x402/settle"


def test_selection_defaults_to_dev(monkeypatch):
    from acr_core import reset_settings

    reset_settings()
    reset_facilitator()
    try:
        assert isinstance(get_facilitator(), DevFacilitator)
    finally:
        reset_facilitator()


def test_auto_mode_requires_real_url(monkeypatch):
    # In auto mode a non-http URL (e.g. a leftover value) must fall back to Dev,
    # never mis-select the Circle gate → the root cause of the "no api query" bug.
    from acr_core import reset_settings

    monkeypatch.setenv("ACR_X402_MODE", "auto")
    monkeypatch.setenv("ACR_X402_FACILITATOR_URL", "not-a-url")
    monkeypatch.setenv("ACR_X402_PAY_TO", "0xSeller")
    reset_settings()
    reset_facilitator()
    try:
        assert isinstance(get_facilitator(), DevFacilitator)
        monkeypatch.setenv("ACR_X402_FACILITATOR_URL", "https://fac.example")
        reset_settings()
        reset_facilitator()
        assert isinstance(get_facilitator(), CircleFacilitator)
    finally:
        reset_settings()
        reset_facilitator()


def test_selection_circle_when_configured():
    fac = CircleFacilitator(settings=_settings())
    ch = fac.challenge(_req())
    assert ch.status_code == 402
    # The b64 header carries the FULL envelope (what GatewayClient.pay decodes).
    envelope = json.loads(base64.b64decode(ch.headers["PAYMENT-REQUIRED"]))
    # Gateway API requires x402Version 2 and a `resource` OBJECT (the buyer SDK
    # copies envelope.resource verbatim into the payload it signs).
    assert envelope["x402Version"] == 2
    assert set(envelope["resource"]) >= {"url", "description", "mimeType"}
    assert envelope["resource"]["mimeType"] == "application/json"
    reqs = envelope["accepts"][0]
    assert reqs["scheme"] == "exact"
    assert reqs["network"] == "eip155:5042002"
    assert reqs["asset"] == "0x3600000000000000000000000000000000000000"
    assert reqs["payTo"] == "0xSeller"
    # Both the v1 and v2 amount keys are emitted (interop hedge).
    assert reqs["maxAmountRequired"] == "100"  # 0.0001 USDC × 1e6
    assert reqs["amount"] == "100"
    # The exact extra shape @circle-fin/x402-batching selects on.
    assert reqs["extra"]["name"] == "GatewayWalletBatched"
    assert reqs["extra"]["version"] == "1"
    assert reqs["extra"]["verifyingContract"].startswith("0x")
    assert reqs["resource"] == "http://test/prints"
    # The JSON body mirrors the header envelope.
    assert ch.body == envelope


def test_challenge_body_is_spec_shaped_via_http():
    """Through the app: the PaymentRequired handler renders {x402Version, accepts}."""
    from acr_core import reset_settings
    from index_api.app import app

    reset_settings()
    reset_facilitator()
    try:
        client = TestClient(app)
        r = client.get("/prints")  # Dev gate (default selection)
        assert r.status_code == 402
        body = r.json()
        assert body["x402Version"] == 2
        assert isinstance(body["resource"], dict) and body["resource"]["url"].endswith("/prints")
        acc = body["accepts"][0]
        assert acc["maxAmountRequired"] == acc["amount"] == "100"
        assert acc["payTo"].startswith("0x")
        assert r.headers["X-402-Price"] == "0.0001"
        # The dev gate also ships the b64 envelope, so GatewayClient.supports()
        # can probe a dev API.
        assert "PAYMENT-REQUIRED" in r.headers

        set_facilitator(CircleFacilitator(settings=_settings()))
        r2 = client.get("/prints")
        assert r2.status_code == 402
        assert r2.json()["accepts"][0]["payTo"] == "0xSeller"
        assert "PAYMENT-REQUIRED" in r2.headers
    finally:
        reset_settings()
        reset_facilitator()


def test_price_from_settings(monkeypatch):
    """ACR_X402_PRICE_USDC drives the challenge amount and the dev gate check."""
    from acr_core import reset_settings

    monkeypatch.setenv("ACR_X402_PRICE_USDC", "0.0005")
    reset_settings()
    reset_facilitator()
    try:
        fac = get_facilitator()
        assert isinstance(fac, DevFacilitator)
        ch = fac.challenge(_req())
        assert ch.body["accepts"][0]["maxAmountRequired"] == "500"
        with pytest.raises(HTTPException):  # old price now underpays
            asyncio.run(fac.process(_req(), "x402 0xagent:0.0001", Response()))
        receipt = asyncio.run(fac.process(_req(), "x402 0xagent:0.0005", Response()))
        assert receipt.amount_usdc == 0.0005
    finally:
        monkeypatch.undo()
        reset_settings()
        reset_facilitator()


def test_dev_gate_rejects_non_finite_amounts():
    # "nan"/"inf" parse as floats and defeat a plain >= check (NaN comparisons
    # are all False); a recorded non-finite amount would poison the revenue
    # counter and 500 every JSON endpoint that serves it.
    fac = DevFacilitator()
    for bad in ("nan", "inf", "-inf", "+nan"):
        with pytest.raises(HTTPException):
            asyncio.run(fac.process(None, f"x402 0xagent:{bad}", Response()))
    assert fac.paid_queries == 0 and fac.revenue_usdc == 0.0


def test_paid_query_unknown_index_404s_without_charging():
    """index_id is validated BEFORE the payment dependency — a buyer must never
    be charged (settlement is irrevocable live) for a resource that can't exist."""
    from index_api.app import app

    fac = DevFacilitator()
    set_facilitator(fac)
    try:
        client = TestClient(app)
        r = client.get("/curve/BOGUS", headers={"X-Payment": "x402 0xagent:0.0001"})
        assert r.status_code == 404
        assert fac.paid_queries == 0 and fac.revenue_usdc == 0.0
        # Unpaid probe of an unknown index also 404s (not 402) — the buyer
        # learns the id is invalid before signing anything.
        assert client.get("/vol/BOGUS").status_code == 404
        # Known index still charges and serves.
        assert client.get("/vol/ACR-INF", headers={"X-Payment": "x402 0xa:0.0001"}).status_code == 200
        assert fac.paid_queries == 1
    finally:
        reset_facilitator()


def test_mode_dev_wins_over_circle_config(monkeypatch):
    """ACR_X402_MODE=dev forces the mock gate even with Circle vars present —
    the Terminal's paid-query demo loop on a machine with a live .env."""
    from acr_core import reset_settings

    monkeypatch.setenv("ACR_X402_FACILITATOR_URL", "https://fac.example")
    monkeypatch.setenv("ACR_X402_PAY_TO", "0xSeller")
    monkeypatch.setenv("ACR_X402_MODE", "dev")
    reset_settings()
    reset_facilitator()
    try:
        assert isinstance(get_facilitator(), DevFacilitator)
    finally:
        # monkeypatch undoes env only — both singletons stay poisoned otherwise.
        monkeypatch.undo()
        reset_settings()
        reset_facilitator()


def test_mode_circle_explicit_fails_closed_when_unconfigured(monkeypatch):
    from acr_core import reset_settings

    monkeypatch.setenv("ACR_X402_MODE", "circle")
    reset_settings()
    reset_facilitator()
    try:
        assert isinstance(get_facilitator(), CircleFacilitator)
    finally:
        monkeypatch.undo()
        reset_settings()
        reset_facilitator()


def test_verify_settle_success_sets_response_and_counts():
    fac = CircleFacilitator(
        http_client=_mock_client(
            {"isValid": True, "payer": "0xbuyer"},
            {
                "success": True,
                "transaction": "0d5c8e1a-4a5b-4f3c-9c6e-7b2f1a0d9e8f",
                "network": "eip155:5042002",
                "payer": "0xbuyer",
            },
        ),
        settings=_settings(),
    )
    resp = Response()
    receipt = asyncio.run(fac.process(_req(), _sig_header({"from": "0xfallback"}), resp))
    assert receipt.tx_ref == "0d5c8e1a-4a5b-4f3c-9c6e-7b2f1a0d9e8f"
    assert receipt.payer == "0xbuyer"  # settle response payer is authoritative
    assert receipt.network == "eip155:5042002"
    assert fac.paid_queries == 1 and fac.revenue_usdc > 0
    pr = json.loads(base64.b64decode(resp.headers["PAYMENT-RESPONSE"]))
    assert pr["success"] is True
    assert pr["transaction"] == "0d5c8e1a-4a5b-4f3c-9c6e-7b2f1a0d9e8f"
    assert pr["payer"] == "0xbuyer"
    # Both canonical and X- prefixed confirmation headers are set.
    assert resp.headers["X-PAYMENT-RESPONSE"] == resp.headers["PAYMENT-RESPONSE"]


def test_verify_invalid_is_402_with_reason():
    fac = CircleFacilitator(
        http_client=_mock_client(
            {"isValid": False, "invalidReason": "invalid_signature"},
            {"success": True, "transaction": "x"},
        ),
        settings=_settings(),
    )
    with pytest.raises(HTTPException) as ei:
        asyncio.run(fac.process(_req(), _sig_header({"from": "0xb"}), Response()))
    assert ei.value.status_code == 402
    assert "invalid_signature" in ei.value.detail
    assert fac.paid_queries == 0


def test_settle_failure_is_402_with_reason():
    fac = CircleFacilitator(
        http_client=_mock_client(
            {"isValid": True},
            {"success": False, "errorReason": "insufficient_balance", "transaction": ""},
        ),
        settings=_settings(),
    )
    with pytest.raises(HTTPException) as ei:
        asyncio.run(fac.process(_req(), _sig_header({"from": "0xb"}), Response()))
    assert ei.value.status_code == 402
    assert "insufficient_balance" in ei.value.detail
    assert fac.paid_queries == 0


def test_network_error_fails_closed():
    fac = CircleFacilitator(
        http_client=_mock_client({"isValid": True}, {"success": True}, raise_on="verify"),
        settings=_settings(),
    )
    with pytest.raises(HTTPException) as ei:
        asyncio.run(fac.process(_req(), _sig_header({"from": "0xb"}), Response()))
    assert ei.value.status_code == 402  # never serve unpaid


def test_integration_paid_query_via_testclient():
    from acr_sim import SimConfig
    from acr_tape import SimSource
    from index_api.app import app, store

    store.source = SimSource(config=SimConfig(seed=4, horizon=3600.0, events_per_service=800))
    store.refresh(ts=3600.0)
    set_facilitator(
        CircleFacilitator(
            http_client=_mock_client(
                {"isValid": True},
                {
                    "success": True,
                    "transaction": "7b9a3c21-0f4e-4d2a-8b1c-5e6f7a8b9c0d",
                    "network": "eip155:5042002",
                    "payer": "0xagent",
                },
            ),
            settings=_settings(),
        )
    )
    try:
        client = TestClient(app)
        # No payment → 402 with PAYMENT-REQUIRED header AND spec-shaped body.
        r0 = client.get("/prints")
        assert r0.status_code == 402 and "PAYMENT-REQUIRED" in r0.headers
        assert r0.json()["accepts"][0]["scheme"] == "exact"
        # Paid → 200 + PAYMENT-RESPONSE.
        r1 = client.get("/prints", headers={"PAYMENT-SIGNATURE": _sig_header({"from": "0xagent"})})
        assert r1.status_code == 200
        assert "PAYMENT-RESPONSE" in r1.headers
        assert "ACR-INF" in r1.json()["prints"]
        assert client.get("/revenue").json()["paid_queries"] >= 1
    finally:
        reset_facilitator()
