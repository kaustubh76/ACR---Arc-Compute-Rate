"""Human-proof gate tests — and the honesty of what a proof is NOT allowed to do.

The interesting cases are the refusals: a replayed proof, an expired nonce, a
proof scoped to another app, a salt that does not match the mirror's commitment,
and every transport failure — each of which must end as a 401 or 503 and never as
a served answer. Plus the two disclosure properties the privacy claim rests on:
the nullifier must not reach a response or an unmasked log line, and the salt
must not reach either at all.
"""

from __future__ import annotations

import logging

import pytest
from acr_core.config import ACRSettings
from acr_oracle_client.humanid import cluster_id, current_window
from fastapi import HTTPException
from fastapi.testclient import TestClient
from index_api import tca as tca_mod
from index_api.humanid import (
    AgentKitVerifier,
    DevHumanVerifier,
    _Nonces,
    get_verifier,
    mask,
    reset_verifier,
    set_verifier,
)

NULLIFIER = "0x" + "11" * 32
SALT = "0x" + "22" * 32
# keccak256(SALT) — the value HumanIdMirror would have been deployed with.
COMMITMENT = "0xc4bd59e1394781d1c7bf20a2c0b30c2acc9fbdd52dc5e0d76917de4034ebdf59"


def _env(monkeypatch, **over):
    from acr_core import reset_settings

    base = {
        "ACR_HUMANID_MODE": "dev",
        "ACR_HUMANID_SALT": SALT,
        "ACR_HUMANID_SALT_COMMITMENT": COMMITMENT,
        "ACR_SUBGRAPH_URL": "https://example.invalid",
    }
    base.update(over)
    for k, v in base.items():
        monkeypatch.setenv(k, v)
    reset_settings()
    reset_verifier()


def _client() -> TestClient:
    from index_api.app import app

    return TestClient(app)


def _proof(client: TestClient) -> tuple[dict, str]:
    """Take a challenge and answer it — the flow a real caller performs."""
    nonce = client.get("/tca/human").json()["nonce"]
    return {"HUMAN-PROOF": f"humanid {NULLIFIER}:{nonce}"}, nonce


def _fake_graph(monkeypatch, cluster_payload, days_payload):
    def fake(url, query, variables, key):
        return cluster_payload if "humanCluster" in query else days_payload

    monkeypatch.setattr(tca_mod, "graph_query", fake)


# --- the challenge -----------------------------------------------------------


def test_a_request_without_a_proof_is_challenged_with_a_nonce(monkeypatch):
    _env(monkeypatch)
    try:
        r = _client().get("/tca/human")
        assert r.status_code == 401
        body = r.json()
        assert body["error"] == "human proof required"
        assert len(body["nonce"]) == 32
        # Scoped to this resource, so a proof minted for another route cannot be
        # presented here.
        assert body["resource"] == "/tca/human"
        assert r.headers["WWW-Authenticate"].startswith("HumanProof")
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_a_verified_proof_derives_the_cluster_the_resolver_would_record(monkeypatch):
    """The cluster the API looks up must be the one the resolver wrote. If these
    disagreed the lookup would miss and every human would read as unresolved —
    a silent zero rather than an error."""
    _env(monkeypatch)
    try:
        client = _client()
        _fake_graph(monkeypatch, {"humanCluster": {"wallets": []}}, {})
        headers, _ = _proof(client)
        got = client.get("/tca/human", headers=headers).json()
        expected = "0x" + cluster_id(NULLIFIER, SALT, current_window()).hex()
        assert got["human"]["cluster"] == expected
    finally:
        monkeypatch.undo()
        reset_verifier()


# --- the refusals ------------------------------------------------------------


def test_a_replayed_proof_is_refused(monkeypatch):
    """A nonce spendable twice would turn 'this human authorized this call' into
    'this human authorized one call, and anyone who saw it can repeat it'."""
    _env(monkeypatch)
    try:
        client = _client()
        _fake_graph(monkeypatch, {"humanCluster": {"wallets": []}}, {})
        headers, _ = _proof(client)
        assert client.get("/tca/human", headers=headers).status_code == 200
        assert client.get("/tca/human", headers=headers).status_code == 401
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_an_expired_nonce_is_refused():
    nonces = _Nonces(ttl_s=300.0)
    n = nonces.issue(now=0.0)
    assert nonces.spend(n, now=301.0) is False


def test_a_nonce_is_spendable_exactly_once():
    nonces = _Nonces()
    n = nonces.issue(now=0.0)
    assert nonces.spend(n, now=1.0) is True
    assert nonces.spend(n, now=2.0) is False


def test_an_unknown_nonce_is_refused():
    assert _Nonces().spend("never-issued", now=1.0) is False


@pytest.mark.parametrize(
    "header",
    ["", "garbage", "bearer 0xabc:nonce", "humanid no-colon-here"],
)
def test_a_malformed_or_wrongly_schemed_proof_is_refused(monkeypatch, header):
    _env(monkeypatch)
    try:
        r = _client().get("/tca/human", headers={"HUMAN-PROOF": header})
        assert r.status_code == 401
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_a_salt_that_does_not_match_the_commitment_fails_closed(monkeypatch):
    """A wrong salt derives cluster ids that match nothing, so every human comes
    back empty — indistinguishable from 'this human never traded'. Refuse loudly
    instead of publishing a silent zero."""
    _env(monkeypatch, ACR_HUMANID_SALT_COMMITMENT="0x" + "ff" * 32)
    try:
        client = _client()
        headers, _ = _proof(client)
        r = client.get("/tca/human", headers=headers)
        assert r.status_code == 503
        assert "commitment" in r.json()["detail"]
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_no_salt_configured_fails_closed(monkeypatch):
    _env(monkeypatch, ACR_HUMANID_SALT="")
    try:
        client = _client()
        headers, _ = _proof(client)
        assert client.get("/tca/human", headers=headers).status_code == 503
    finally:
        monkeypatch.undo()
        reset_verifier()


# --- disclosure --------------------------------------------------------------


def test_neither_the_nullifier_nor_the_salt_reaches_a_response(monkeypatch):
    _env(monkeypatch)
    try:
        client = _client()
        _fake_graph(monkeypatch, {"humanCluster": {"wallets": []}}, {})
        headers, _ = _proof(client)
        body = client.get("/tca/human", headers=headers).text
        assert NULLIFIER[2:] not in body
        assert SALT[2:] not in body
        # …nor into the challenge, which is served before anything is verified.
        assert SALT[2:] not in client.get("/tca/human").text
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_the_nullifier_is_masked_in_logs(monkeypatch, caplog):
    _env(monkeypatch)
    try:
        client = _client()
        _fake_graph(monkeypatch, {"humanCluster": {"wallets": []}}, {})
        headers, _ = _proof(client)
        with caplog.at_level(logging.INFO, logger="index_api.humanid"):
            client.get("/tca/human", headers=headers)
        text = "\n".join(r.getMessage() for r in caplog.records)
        assert "••••" in text
        assert NULLIFIER[2:] not in text
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_mask_keeps_a_tail_short_enough_to_be_nobody():
    assert mask("0xdeadbeef") == "••••eef"
    assert mask("ab") == "••••?"


def test_the_response_never_enumerates_the_fleet(monkeypatch):
    """The caller knows their own wallets; a response that listed them would hand
    a fleet to anyone who later saw it."""
    _env(monkeypatch)
    try:
        client = _client()
        wallets = ["0x" + "a1" * 20, "0x" + "b2" * 20]
        _fake_graph(
            monkeypatch,
            {"humanCluster": {"wallets": [{"id": w} for w in wallets]}},
            {"payerDays": [], "settlements": []},
        )
        headers, _ = _proof(client)
        body = client.get("/tca/human", headers=headers)
        assert body.json()["human"]["wallet_count"] == 2
        for w in wallets:
            assert w[2:] not in body.text
    finally:
        monkeypatch.undo()
        reset_verifier()


# --- the union ---------------------------------------------------------------


def test_the_fleet_is_aggregated_as_one_book(monkeypatch):
    """Two wallets, one human. The reroute must see a single book: unioning two
    finished cards afterwards could recommend a move the fleet already made."""
    _env(monkeypatch)
    try:
        client = _client()
        _fake_graph(
            monkeypatch,
            {"humanCluster": {"wallets": [{"id": "0x" + "a1" * 20}, {"id": "0x" + "b2" * 20}]}},
            {
                "payerDays": [
                    {"day": 1, "spent": "600000", "bmSpent": "600000",
                     "wSlipTenthBp": "600000000", "overpay": "60000", "n": 30, "nAll": 30},
                ],
                "settlements": [
                    {"seller": {"id": "0xdear"}, "amount": "400000",
                     "slippageTenthBp": "2000", "synthetic": False, "index": "ACR-INF"},
                    {"seller": {"id": "0xcheap"}, "amount": "200000",
                     "slippageTenthBp": "-100", "synthetic": False, "index": "ACR-INF"},
                ],
            },
        )
        headers, _ = _proof(client)
        r = client.get("/tca/human", headers=headers).json()
        assert r["available"] is True
        assert r["human"]["wallet_count"] == 2
        # Worst first, and both wallets' sellers in ONE breakdown.
        assert [b["seller"] for b in r["by_seller"]] == ["0xdear", "0xcheap"]
        assert r["reroute"]["from"] == "0xdear"
        assert r["reroute"]["to"] == "0xcheap"
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_a_human_with_no_wallets_says_so_rather_than_reporting_zero_spend(monkeypatch):
    _env(monkeypatch)
    try:
        client = _client()
        _fake_graph(monkeypatch, {"humanCluster": None}, {})
        headers, _ = _proof(client)
        r = client.get("/tca/human", headers=headers).json()
        assert r["available"] is False
        assert "no wallets are resolved" in r["reason"]
        assert r["human"]["wallet_count"] == 0
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_a_window_longer_than_the_rotation_is_refused(monkeypatch):
    """A cluster describes THIS window's fleet. Reaching further back would union
    today's wallets over a period they may not have been the fleet for."""
    _env(monkeypatch)
    try:
        client = _client()
        headers, _ = _proof(client)
        r = client.get("/tca/human?days=30", headers=headers).json()
        assert r["available"] is False
        assert "rotation" in r["reason"]
    finally:
        monkeypatch.undo()
        reset_verifier()


# --- backend selection + the agentkit path -----------------------------------


def test_mode_dev_wins_over_agentkit_config(monkeypatch):
    _env(monkeypatch, ACR_HUMANID_VERIFIER_URL="https://verifier.example",
         ACR_HUMANID_APP_ID="app_123")
    try:
        assert isinstance(get_verifier(), DevHumanVerifier)
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_auto_mode_requires_a_real_verifier_url(monkeypatch):
    _env(monkeypatch, ACR_HUMANID_MODE="auto", ACR_HUMANID_VERIFIER_URL="",
         ACR_HUMANID_APP_ID="app_123")
    try:
        assert isinstance(get_verifier(), DevHumanVerifier)
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_auto_mode_selects_agentkit_when_configured(monkeypatch):
    _env(monkeypatch, ACR_HUMANID_MODE="auto",
         ACR_HUMANID_VERIFIER_URL="https://verifier.example", ACR_HUMANID_APP_ID="app_123")
    try:
        assert isinstance(get_verifier(), AgentKitVerifier)
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_agentkit_fails_closed_when_unconfigured(monkeypatch):
    _env(monkeypatch, ACR_HUMANID_MODE="agentkit", ACR_HUMANID_VERIFIER_URL="",
         ACR_HUMANID_APP_ID="")
    try:
        client = _client()
        r = client.get("/tca/human", headers={"HUMAN-PROOF": "anything"})
        assert r.status_code == 503
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_agentkit_rejects_a_proof_scoped_to_another_app(monkeypatch):
    import asyncio
    import base64
    import json
    import types

    _env(monkeypatch, ACR_HUMANID_MODE="agentkit",
         ACR_HUMANID_VERIFIER_URL="https://verifier.example", ACR_HUMANID_APP_ID="app_ours")
    try:
        v = AgentKitVerifier()
        nonce = v.nonces.issue()
        header = base64.b64encode(
            json.dumps({"nonce": nonce, "app_id": "app_theirs"}).encode()
        ).decode()
        req = types.SimpleNamespace(url=types.SimpleNamespace(path="/tca/human"))
        with pytest.raises(HTTPException) as e:
            asyncio.run(v.nullifier_of(req, header))
        assert e.value.status_code == 401
        assert "another app" in e.value.detail
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_agentkit_fails_closed_on_a_transport_error(monkeypatch):
    """An unverified human must never be served as a verified one."""
    import asyncio
    import base64
    import json
    import types

    _env(monkeypatch, ACR_HUMANID_MODE="agentkit",
         ACR_HUMANID_VERIFIER_URL="https://verifier.example", ACR_HUMANID_APP_ID="app_ours")
    try:
        v = AgentKitVerifier()

        async def boom(payload, nonce):
            raise ConnectionError("network down")

        v._verify_remote = boom
        nonce = v.nonces.issue()
        header = base64.b64encode(json.dumps({"nonce": nonce}).encode()).decode()
        req = types.SimpleNamespace(url=types.SimpleNamespace(path="/tca/human"))
        with pytest.raises(HTTPException) as e:
            asyncio.run(v.nullifier_of(req, header))
        assert e.value.status_code == 401
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_the_verifier_is_injectable_for_tests(monkeypatch):
    _env(monkeypatch)
    try:
        mine = DevHumanVerifier()
        set_verifier(mine)
        assert get_verifier() is mine
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_humanid_info_reports_the_backend_and_the_sandbox_limit(monkeypatch):
    """Nobody should have to take the README's word for what 'verified human'
    means in this deployment."""
    _env(monkeypatch)
    try:
        info = _client().get("/humanid/info").json()
        assert info["backend"] == "dev"
        assert info["sandbox"] is True
        assert info["salt_matches_commitment"] is True
        assert info["rotation_window_days"] == 7
    finally:
        monkeypatch.undo()
        reset_verifier()


def test_a_settings_object_never_carries_a_salt_by_default():
    """A default salt would be a shared secret in a public repo."""
    assert ACRSettings(_env_file=None).humanid_salt == ""
